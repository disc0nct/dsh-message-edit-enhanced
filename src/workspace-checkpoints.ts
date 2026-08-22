/**
 * Workspace checkpointing for cascading message deletion.
 *
 * Every time a `user/message` lands in any session, this module captures a
 * best-effort snapshot of the workspace the session is attached to: a full
 * path→content-hash manifest plus content-addressed text blobs. Deleting a
 * message later restores exactly that pre-message state.
 *
 * Storage layout (plugin-owned, inside the DSH home — never inside a user
 * workspace):
 *   <root>/manifests/<sessionId>/<seq>.json   one full tree manifest per user message
 *   <root>/blobs/<hash[0:2]>/<hash>           deduplicated file contents
 *   <root>/audit.log                          JSONL audit trail of deletions
 *
 * Workspace reads/writes go through the injected `fs` service (atomic writes,
 * policy-respecting); only unlinking files created after a checkpoint falls
 * back to contained `node:fs` removal because the service has no delete API.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Structural subset of the injected `fs` service used here (kept local so the
 * plugin does not need a build-time dependency on the dsh-fs package). */
interface FsTargetLike {
 targetKey: unknown
 displayPath: string
}

interface FsDirEntryLike {
 name: string
 type: 'file' | 'directory' | 'other'
 target: FsTargetLike
 size?: number | undefined
}

interface WorkspaceLike {
 readonly id: string
 readonly path: string
 readonly sessionIds: readonly string[]
}

interface FsServiceLike {
 resolve(path: string, opts?: { cwd?: string }): Promise<FsTargetLike>
 listDir(target: FsTargetLike): Promise<FsDirEntryLike[]>
 readText(target: FsTargetLike): Promise<string>
 writeText(target: FsTargetLike, content: string): Promise<unknown>
}

export function fsOf(ctx: Context): FsServiceLike | undefined {
 return ctx.get('fs') as FsServiceLike | undefined
}

function sourceWorkspaceOf(ctx: Context, sessionId: string): WorkspaceLike | undefined {
 const registry = ctx.get('workspaceRegistry') as { list(): WorkspaceLike[] } | undefined
 if (registry === undefined) return undefined
 return registry.list().find(workspace => workspace.sessionIds.includes(sessionId))
}

/** One full-tree manifest captured before a user message was processed. */
export interface CheckpointManifest {
 v: 1
 sessionId: string
 seq: number
 time: number
 workspaceId: string
 workspacePath: string
 /** Workspace-relative path → sha256 of content at capture time. */
 files: Record<string, string>
}

export type SkippedReason = 'binary' | 'too-large'

export interface RollbackPlan {
 /** False when no usable checkpoint exists for the requested event. */
 available: boolean
 /** Human-readable explanation when unavailable. */
 reason?: string
 manifest?: CheckpointManifest
 /** Files whose current content differs from the checkpoint (restore targets). */
 filesToWrite: Array<{ path: string; hash: string }>
 /** Files that exist now but did not exist at the checkpoint (removal targets). */
 filesToRemove: string[]
 skipped: Array<{ path: string; reason: SkippedReason }>
 warnings: string[]
}

export interface ApplyRollbackOutcome {
 reverted: number
 removed: number
 failures: Array<{ path: string; error: string }>
}

const MANIFEST_VERSION = 1
const MAX_DEPTH = 12
const MAX_FILES = 4_000
const MAX_FILE_BYTES = 512 * 1024
const MAX_CAPTURE_BYTES = 24 * 1024 * 1024

const IGNORED_NAMES = new Set([
 '.git', '.hg', '.svn', '.dsh', '.cache', '.next', '.nuxt',
 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
 'coverage', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache',
])

export function checkpointRoot(): string {
 const raw = process.env['DSH_HOME']
 const home = raw !== undefined && raw.trim() !== '' ? raw.trim() : join(homedir(), '.dsh')
 return join(home, 'message-edit-enhanced', 'checkpoints')
}

function safeSegment(value: string): string {
 return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

function manifestFile(sessionId: string, seq: number): string {
 return join(checkpointRoot(), 'manifests', safeSegment(sessionId), `${String(seq)}.json`)
}

function blobFile(hash: string): string {
 return join(checkpointRoot(), 'blobs', hash.slice(0, 2), hash)
}

function hashText(content: string): string {
 return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function writeAtomic(file: string, data: string): Promise<void> {
 await mkdir(dirname(file), { recursive: true })
 const temp = `${file}.${process.pid}.${Date.now()}.tmp`
 await writeFile(temp, data, 'utf8')
 await rename(temp, file)
}

async function readBlob(hash: string): Promise<string> {
 return readFile(blobFile(hash), 'utf8')
}

async function blobExists(hash: string): Promise<boolean> {
 try {
  await stat(blobFile(hash))
  return true
 } catch {
  return false
 }
}

/** Per-session capture serialization: walks never interleave for one session. */
const captureChains = new Map<string, Promise<void>>()

function chainCapture(sessionId: string, task: () => Promise<void>): void {
 const previous = captureChains.get(sessionId) ?? Promise.resolve()
 const next = previous.then(task, task)
 captureChains.set(sessionId, next)
 void next.catch(() => {}).finally(() => {
  if (captureChains.get(sessionId) === next) captureChains.delete(sessionId)
 })
}

interface TreeSnapshot {
 files: Record<string, string>
 fileCount: number
 contents: Map<string, string>
 skipped: Array<{ path: string; reason: SkippedReason }>
 warnings: string[]
}

/** Walk the workspace through the injected fs service, hashing every readable
 * text file. Relative paths are built during the walk so any backend's opaque
 * display paths stay out of the stored keys. */
async function snapshotTree(ctx: Context, workspacePath: string): Promise<TreeSnapshot> {
 const fs = fsOf(ctx)
 if (fs === undefined) throw new Error('Filesystem service is not available.')
 const result: TreeSnapshot = { files: {}, fileCount: 0, contents: new Map(), skipped: [], warnings: [] }
 const rootTarget = await fs.resolve(workspacePath)
 let budget = MAX_CAPTURE_BYTES

 const visit = async (target: FsTargetLike, relBase: string, depth: number): Promise<void> => {
  if (result.fileCount >= MAX_FILES || budget <= 0 || depth > MAX_DEPTH) return
  const children = await fs.listDir(target)
  for (const child of children) {
   if (result.fileCount >= MAX_FILES || budget <= 0) return
   const rel = relBase === '' ? child.name : `${relBase}/${child.name}`
   if (child.type === 'directory') {
    if (!IGNORED_NAMES.has(child.name)) await visit(child.target, rel, depth + 1)
    continue
   }
   if (child.type !== 'file') continue
   if ((child.size ?? 0) > MAX_FILE_BYTES) {
    result.skipped.push({ path: rel, reason: 'too-large' })
    continue
   }
   let content: string
   try {
    content = await fs.readText(child.target)
   } catch {
    result.skipped.push({ path: rel, reason: 'binary' })
    continue
   }
   if (content.length > MAX_FILE_BYTES || content.length > budget) {
    result.skipped.push({ path: rel, reason: 'too-large' })
    continue
   }
   budget -= content.length
   const hash = hashText(content)
   result.files[rel] = hash
   result.fileCount += 1
   if (!(await blobExists(hash))) result.contents.set(hash, content)
  }
 }

 await visit(rootTarget, '', 0)
 if (result.fileCount >= MAX_FILES) {
  result.warnings.push(`Workspace tree exceeds ${String(MAX_FILES)} files; snapshot covers the first ${String(MAX_FILES)}.`)
 }
 return result
}

/** Capture the pre-message workspace state for one appended user message.
 * Fire-and-forget safe: every failure is logged, never thrown into the feed. */
export function captureCheckpoint(ctx: Context, sessionId: string, seq: number): void {
 chainCapture(sessionId, async () => {
  try {
   const workspace = sourceWorkspaceOf(ctx, sessionId)
   if (workspace === undefined) return // Session has no registered workspace; nothing to snapshot.
   const tree = await snapshotTree(ctx, workspace.path)
   for (const [hash, content] of tree.contents) {
    await writeAtomic(blobFile(hash), content)
   }
   const manifest: CheckpointManifest = {
    v: MANIFEST_VERSION,
    sessionId,
    seq,
    time: Date.now(),
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    files: tree.files,
   }
   await writeAtomic(manifestFile(sessionId, seq), JSON.stringify(manifest))
  } catch (error) {
   console.error('[message-edit-enhanced] checkpoint capture failed:', error)
  }
 })
}

function isManifest(value: unknown): CheckpointManifest | null {
 if (typeof value !== 'object' || value === null) return null
 const record = value as Record<string, unknown>
 if (record['v'] !== MANIFEST_VERSION) return null
 if (typeof record['sessionId'] !== 'string') return null
 if (typeof record['workspacePath'] !== 'string') return null
 if (typeof record['seq'] !== 'number' || typeof record['workspaceId'] !== 'string') return null
 if (typeof record['files'] !== 'object' || record['files'] === null) return null
 return value as CheckpointManifest
}

async function loadManifestFile(sessionId: string, seq: number): Promise<CheckpointManifest | null> {
 try {
  const raw = JSON.parse(await readFile(manifestFile(sessionId, seq), 'utf8')) as unknown
  return isManifest(raw)
 } catch {
  return null
 }
}

/** Load the exact checkpoint captured before the given user message event. */
export async function loadCheckpoint(sessionId: string, seq: number): Promise<CheckpointManifest | null> {
 return loadManifestFile(sessionId, seq)
}

/** Build a read-only rollback plan for deleting everything from `eventSeq` on.
 * Never mutates anything. Requires the EXACT checkpoint for the target event:
 * restoring an older checkpoint would also revert preserved earlier exchanges. */
export async function planRollback(ctx: Context, sessionId: string, eventSeq: number): Promise<RollbackPlan> {
 const unavailable = (reason: string): RollbackPlan => ({
  available: false,
  reason,
  filesToWrite: [],
  filesToRemove: [],
  skipped: [],
  warnings: [],
 })
 const manifest = await loadManifestFile(sessionId, eventSeq)
 if (manifest === null) return unavailable('No workspace checkpoint exists for this message.')
 const workspace = sourceWorkspaceOf(ctx, sessionId)
 if (workspace === undefined) return unavailable('The session is not attached to a registered workspace.')
 const fs = fsOf(ctx)
 if (fs === undefined) return unavailable('The filesystem service is not available.')
 if (workspace.path !== manifest.workspacePath) {
  return unavailable(`Snapshot recorded workspace ${manifest.workspacePath}, which no longer matches ${workspace.path}.`)
 }

 const current = await snapshotTree(ctx, workspace.path)
 const filesToWrite: Array<{ path: string; hash: string }> = []
 for (const [path, hash] of Object.entries(manifest.files)) {
  if (current.files[path] === hash) continue // unchanged since the checkpoint
  filesToWrite.push({ path, hash })
 }
 const plan: RollbackPlan = {
  available: true,
  manifest,
  filesToWrite: filesToWrite.sort((a, b) => a.path.localeCompare(b.path)),
  filesToRemove: Object.keys(current.files)
   .filter(path => manifest.files[path] === undefined)
   .sort((a, b) => a.localeCompare(b)),
  skipped: current.skipped,
  warnings: [],
 }
 if (current.fileCount >= MAX_FILES || current.skipped.length > 0) {
  plan.warnings.push(
   'Some files were not covered by the snapshot (binary, oversized, or ignored paths); they will be left untouched.',
  )
 }
 return plan
}

function assertContained(workspacePath: string, rel: string): string {
 if (rel.length === 0 || isAbsolute(rel) || rel.split('/').includes('..')) {
  throw new Error(`Refusing to touch a path outside the workspace: ${rel}`)
 }
 const absolute = resolvePath(workspacePath, ...rel.split('/'))
 const root = resolvePath(workspacePath)
 if (!(absolute + sep).startsWith(root + sep)) {
  throw new Error(`Refusing to touch a path outside the workspace: ${rel}`)
 }
 return absolute
}

/** Restore the workspace to the planned checkpoint state. Best-effort per file:
 * individual failures are collected so callers can report partial progress;
 * every restore payload is pre-loaded BEFORE anything is mutated. */
export async function applyRollback(
 ctx: Context,
 plan: RollbackPlan,
 workspacePath: string,
): Promise<ApplyRollbackOutcome> {
 const outcome: ApplyRollbackOutcome = { reverted: 0, removed: 0, failures: [] }
 const fs = fsOf(ctx)
 if (fs === undefined || plan.manifest === undefined) {
  outcome.failures.push({ path: '*', error: 'Rollback prerequisites are missing.' })
  return outcome
 }

 const payloads = new Map<string, string>()
 for (const entry of plan.filesToWrite) {
  try {
   payloads.set(entry.hash, await readBlob(entry.hash))
  } catch (error) {
   outcome.failures.push({
    path: entry.path,
    error: `checkpoint blob missing: ${error instanceof Error ? error.message : String(error)}`,
   })
  }
 }
 if (outcome.failures.length > 0) return outcome

 for (const entry of plan.filesToWrite) {
  const content = payloads.get(entry.hash)
  if (content === undefined) continue
  try {
   const absolute = assertContained(workspacePath, entry.path)
   await mkdir(dirname(absolute), { recursive: true })
   const target = await fs.resolve(join(workspacePath, entry.path))
   await fs.writeText(target, content)
   outcome.reverted += 1
  } catch (error) {
   outcome.failures.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) })
  }
 }

 for (const rel of plan.filesToRemove) {
  try {
   await rm(assertContained(workspacePath, rel), { force: true })
   outcome.removed += 1
  } catch (error) {
   outcome.failures.push({ path: rel, error: error instanceof Error ? error.message : String(error) })
  }
 }
 return outcome
}

/** Append one JSONL audit record; returns the audit id carried in results. */
export async function appendAuditEntry(entry: Record<string, unknown>): Promise<string> {
 const auditId = `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
 try {
  const line = `${JSON.stringify({ auditId, time: Date.now(), ...entry })}\n`
  const file = join(checkpointRoot(), 'audit.log')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, line, { flag: 'a', encoding: 'utf8' })
 } catch (error) {
  console.error('[message-edit-enhanced] audit write failed:', error)
 }
 return auditId
}
