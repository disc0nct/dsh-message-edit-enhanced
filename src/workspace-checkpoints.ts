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
 * Performance: consecutive captures reuse the previous manifest's stat
 * signatures (size + mtime) to skip re-reading unchanged files entirely, so
 * steady-state captures cost one metadata stat per file instead of a full
 * content read + hash. Directory walks and hashing run under bounded
 * concurrency so large trees cannot saturate the event loop or the disk.
 *
 * Stability: rollback applies under a per-workspace mutex so two sessions
 * sharing one directory can never interleave restores; every restore payload
 * is pre-loaded before any mutation; individual failures are collected.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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

/** Size/mtime signature used to skip re-reading unchanged files. */
export interface StatSignature {
 /** Byte size. */
 s: number
 /** mtime rounded to whole milliseconds. */
 m: number
}

/** One full-tree manifest captured before a user message was processed. */
export interface CheckpointManifest {
 /** 1 = original schema; 2 = adds statSigs. Both remain readable forever. */
 v: 1 | 2
 sessionId: string
 seq: number
 time: number
 workspaceId: string
 workspacePath: string
 /** Workspace-relative path → sha256 of content at capture time. */
 files: Record<string, string>
 /** v2 only: per-file stat signature at capture time (skip-re-read hints). */
 statSigs?: Record<string, StatSignature>
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

const MANIFEST_VERSION = 2 as const
const MAX_DEPTH = 12
const MAX_FILES = 4_000
const MAX_FILE_BYTES = 512 * 1024
const MAX_CAPTURE_BYTES = 24 * 1024 * 1024
/** Parallel content reads/hashes during one capture. */
const HASH_CONCURRENCY = 12
/** Parallel directory listings during one walk. */
const WALK_CONCURRENCY = 4

function defaultRetention(): number {
 const raw = process.env['MESSAGE_EDIT_CHECKPOINT_MANIFESTS']
 const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10)
 return Number.isFinite(parsed) && parsed >= 2 ? parsed : 500
}

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
 // Detached cleanup must swallow the rejection on the DERIVED promise; the
 // original `next` still reports failures to its caller (and tasks here never
 // throw — they log internally).
 void next.catch(() => {}).finally(() => {
  if (captureChains.get(sessionId) === next) captureChains.delete(sessionId)
 })
}

/** Run `fn` over `items` with at most `limit` concurrent invocations. */
async function pooled<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
 let next = 0
 const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
  while (next < items.length) {
   const index = next
   next += 1
   const item = items[index]
   if (item === undefined) return
   await fn(item)
  }
 })
 await Promise.all(workers)
}

interface TreeSnapshot {
 files: Record<string, string>
 fileCount: number
 statSigs: Record<string, StatSignature>
 contents: Map<string, string>
 skipped: Array<{ path: string; reason: SkippedReason }>
 warnings: string[]
}

interface PreviousSnapshot {
 files: Record<string, string>
 statSigs?: Record<string, StatSignature> | undefined
}

/** Walk the workspace through the injected fs service, collecting entries with
 * bounded parallelism. Relative paths are built during the walk so any
 * backend's opaque display paths stay out of the stored keys. */
async function collectEntries(
 ctx: Context,
 workspacePath: string,
 result: TreeSnapshot,
): Promise<Array<{ rel: string; target: FsTargetLike }>> {
 const fs = fsOf(ctx)
 if (fs === undefined) throw new Error('Filesystem service is not available.')
 const rootTarget = await fs.resolve(workspacePath)
 const entries: Array<{ rel: string; target: FsTargetLike }> = []

 const visit = async (target: FsTargetLike, relBase: string, depth: number): Promise<void> => {
  if (result.fileCount >= MAX_FILES || depth > MAX_DEPTH) return
  const children = await fs.listDir(target)
  const subdirs: Array<{ rel: string; target: FsTargetLike }> = []
  for (const child of children) {
   if (result.fileCount >= MAX_FILES) return
   const rel = relBase === '' ? child.name : `${relBase}/${child.name}`
   if (child.type === 'directory') {
    if (!IGNORED_NAMES.has(child.name)) subdirs.push({ rel, target: child.target })
    continue
   }
   if (child.type !== 'file') continue
   entries.push({ rel, target: child.target })
  }
  await pooled(subdirs, WALK_CONCURRENCY, entry => visit(entry.target, entry.rel, depth + 1))
 }

 await visit(rootTarget, '', 0)
 entries.sort((a, b) => a.rel.localeCompare(b.rel))
 return entries
}

/** Hash the collected tree. Files whose size+mtime match the previous capture
 * reuse the prior hash without any content read; everything else is read and
 * hashed under bounded concurrency. */
async function hashEntries(
 ctx: Context,
 workspacePath: string,
 entries: Array<{ rel: string; target: FsTargetLike }>,
 previous: PreviousSnapshot | undefined,
 result: TreeSnapshot,
): Promise<void> {
 const fs = fsOf(ctx)
 if (fs === undefined) throw new Error('Filesystem service is not available.')
 let budget = MAX_CAPTURE_BYTES

 await pooled(entries, HASH_CONCURRENCY, async ({ rel, target }) => {
  if (budget <= 0 || result.fileCount >= MAX_FILES) return
  const prevSig = previous?.statSigs?.[rel]
  const prevHash = previous?.files[rel]
  if (prevSig !== undefined && prevHash !== undefined) {
   try {
    // node:stat on the computed absolute path is purely a change hint. Any
    // failure falls through to a full read, so remote backends degrade to
    // the old behavior instead of breaking.
    const absolute = resolvePath(workspacePath, ...rel.split('/'))
    const st = await stat(absolute)
    const sig: StatSignature = { s: st.size, m: Math.round(st.mtimeMs) }
    if (sig.s === prevSig.s && sig.m === prevSig.m) {
     result.files[rel] = prevHash
     result.fileCount += 1
     result.statSigs[rel] = prevSig
     return
    }
   } catch {
    // Fall through to the content read.
   }
  }
  let content: string
  try {
   content = await fs.readText(target)
  } catch {
   result.skipped.push({ path: rel, reason: 'binary' })
   return
  }
  if (content.length > MAX_FILE_BYTES || content.length > budget) {
   result.skipped.push({ path: rel, reason: 'too-large' })
   return
  }
  budget -= content.length
  const hash = hashText(content)
  result.files[rel] = hash
  result.fileCount += 1
  try {
   const st = await stat(resolvePath(workspacePath, ...rel.split('/')))
   result.statSigs[rel] = { s: st.size, m: Math.round(st.mtimeMs) }
  } catch {
   // Signature unavailable; the next capture simply re-reads this file.
  }
  if (!(await blobExists(hash))) result.contents.set(hash, content)
 })
}

async function snapshotTree(
 ctx: Context,
 workspacePath: string,
 previous?: PreviousSnapshot | undefined,
): Promise<TreeSnapshot> {
 const result: TreeSnapshot = {
  files: {},
  fileCount: 0,
  statSigs: {},
  contents: new Map(),
  skipped: [],
  warnings: [],
 }
 const entries = await collectEntries(ctx, workspacePath, result)
 await hashEntries(ctx, workspacePath, entries, previous, result)
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
   const previous = await latestManifestBefore(sessionId, seq)
   const previousSnapshot: PreviousSnapshot | undefined = previous === null
    ? undefined
    : { files: previous.files, ...(previous.statSigs === undefined ? {} : { statSigs: previous.statSigs }) }
   const tree = await snapshotTree(ctx, workspace.path, previousSnapshot)
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
    statSigs: tree.statSigs,
   }
   await writeAtomic(manifestFile(sessionId, seq), JSON.stringify(manifest))
   await pruneManifests(sessionId, defaultRetention())
  } catch (error) {
   console.error('[message-edit-enhanced] checkpoint capture failed:', error)
  }
 })
}

/** Keep only the newest `retain` manifests for one session (cheap bound on
 * store growth; blobs dedupe across manifests and are left in place). */
async function pruneManifests(sessionId: string, retain: number): Promise<void> {
 const dir = join(checkpointRoot(), 'manifests', safeSegment(sessionId))
 let names: string[]
 try {
  names = await readdir(dir)
 } catch {
  return
 }
 const seqs = names
  .filter(name => name.endsWith('.json'))
  .map(name => Number.parseInt(name.slice(0, -5), 10))
  .filter(value => Number.isFinite(value))
  .sort((a, b) => b - a)
 for (const stale of seqs.slice(retain)) {
  try {
   await rm(join(dir, `${String(stale)}.json`), { force: true })
  } catch {
   // Best-effort pruning only.
  }
 }
}

function isManifest(value: unknown): CheckpointManifest | null {
 if (typeof value !== 'object' || value === null) return null
 const record = value as Record<string, unknown>
 if (record['v'] !== 1 && record['v'] !== 2) return null
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

/** Latest manifest strictly below `seq`, or null. Used as the change-detection
 * baseline for the next capture. */
async function latestManifestBefore(sessionId: string, seq: number): Promise<CheckpointManifest | null> {
 const dir = join(checkpointRoot(), 'manifests', safeSegment(sessionId))
 let names: string[]
 try {
  names = await readdir(dir)
 } catch {
  return null
 }
 let best: number | null = null
 for (const name of names) {
  if (!name.endsWith('.json')) continue
  const value = Number.parseInt(name.slice(0, -5), 10)
  if (!Number.isFinite(value) || value >= seq) continue
  if (best === null || value > best) best = value
 }
 if (best === null) return null
 return loadManifestFile(sessionId, best)
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

/** Per-workspace rollback serialization: two sessions attached to the same
 * directory must never interleave their restores. */
const workspaceLocks = new Map<string, Promise<unknown>>()

function withWorkspaceLock<T>(workspacePath: string, task: () => Promise<T>): Promise<T> {
 const key = resolvePath(workspacePath)
 const previous = workspaceLocks.get(key) ?? Promise.resolve()
 const next = previous.then(task, task)
 workspaceLocks.set(key, next)
 void next.catch(() => {}).finally(() => {
  if (workspaceLocks.get(key) === next) workspaceLocks.delete(key)
 })
 return next
}

/** Restore the workspace to the planned checkpoint state. Best-effort per file:
 * individual failures are collected so callers can report partial progress;
 * every restore payload is pre-loaded BEFORE anything is mutated. Serialized
 * per workspace path. */
export function applyRollback(
 ctx: Context,
 plan: RollbackPlan,
 workspacePath: string,
): Promise<ApplyRollbackOutcome> {
 return withWorkspaceLock(workspacePath, () => applyRollbackLocked(ctx, plan, workspacePath))
}

async function applyRollbackLocked(
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
