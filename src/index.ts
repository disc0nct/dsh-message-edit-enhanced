/** Host half of Message Edit: turn-atomic forks and structurally reversible versions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { PresetBearingSession } from '@deepseek-ai/dsh-agent-presets'
import type {
 SessionId,
 Session,
 SessionEvent,
 SessionEventType,
 SurfaceEventType,
 SurfaceIntent,
} from '@deepseek-ai/dsh-session'
import type {
 SessionLineageNode,
 SessionRecord,
} from '@deepseek-ai/dsh-session-query'
import type {
 AssistantMessage,
 ContentBlock,
 UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
 applyRollback,
 appendAuditEntry,
 captureCheckpoint,
 planRollback,
} from './workspace-checkpoints.ts'

/** Diagnostic/testing surface for the workspace checkpoint store. */
export { applyRollback, appendAuditEntry, captureCheckpoint, loadCheckpoint, planRollback } from './workspace-checkpoints.ts'
import {
 MESSAGE_EDIT_PATH,
 MESSAGE_EDIT_VERSION_SCHEMA,
 type CascadePolicy,
 type DeleteOperation,
 type EditOperation,
 type EditableBlockKind,
 type EditableMessageBlock,
 type LegacyMessageEditVersionEvent,
 type MessageEditDeletePreview,
 type MessageEditEffect,
 type MessageEditOperation,
 type MessageEditOperationResult,
 type MessageEditTimeline,
 type MessageEditVersionEvent,
 type RetryableTurn,
 type StoredMessageEditVersionEvent,
 type VersionSummary,
} from './shared.ts'

export {
 MESSAGE_EDIT_PATH,
 MESSAGE_EDIT_VERSION_SCHEMA,
 MESSAGE_EDIT_VIEW_ORDER,
} from './shared.ts'
export type {
 CascadePolicy,
 DeleteOperation,
 MessageEditDeletePreview,
 MessageEditDeleteResult,
 DeletePreviewFile,
 DeleteSkippedFile,
 EditOperation,
 EditableBlockKind,
 EditableMessageBlock,
 MessageEditOperation,
 MessageEditOperationResult,
 MessageEditTimeline,
 MessageEditEffect,
 MessageEditInverse,
 MessageEditVersionEvent,
 RerollOperation,
 RetryableTurn,
 RetryOperation,
 VersionOperation,
 VersionSummary,
} from './shared.ts'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Durable branch provenance owned by disc0nct/message-edit-enhanced. */
    'message-edit-enhanced/version': StoredMessageEditVersionEvent
  }
}

interface HttpRequestLike {
 method?: string
 url?: string
 on(event: 'data', listener: (chunk: Uint8Array | string) => void): this
 on(event: 'end', listener: () => void): this
 on(event: 'error', listener: (error: unknown) => void): this
}

interface HttpResponseLike {
 writeHead(status: number, headers?: Record<string, string>): unknown
 end(body?: string): void
}

interface HttpServerLike {
 register(route: {
  kind: 'exact'
  path: string
  handler: (request: HttpRequestLike, response: HttpResponseLike) => void | Promise<void>
 }): () => void
}

declare module '@deepseek-ai/cordis' {
 interface Context {
  webServer: HttpServerLike
 }
}

/** Stable Cordis plugin name. */
export const name = 'message-edit-enhanced'

/** Public services used by the branch transaction and timeline projection. */
export const inject = [
 'sessions',
 'agents',
 'sessionPersistence',
 'sessionQuery',
 'workspaceRegistry',
 'webServer',
]

/** Safety limit for preserve cascades. */
const MAX_PRESERVE_QUEUE = 20

/** Per-session FIFO of in-flight operations: edits/rerolls/retries against the
 * same session run one at a time so `runMaintenance` never races itself. */
const sessionOperationQueues = new Map<string, Promise<unknown>>()

/** Chain one operation behind any pending operation on the same session. */
function serializeSessionOperation<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
 const previous = sessionOperationQueues.get(sessionId) ?? Promise.resolve()
 const next = previous.then(() => task(), () => task())
 sessionOperationQueues.set(sessionId, next)
 // Detached cleanup must swallow the rejection on the DERIVED promise;
 // the original `next` still reports the failure to its caller.
 void next.catch(() => {}).finally(() => {
  if (sessionOperationQueues.get(sessionId) === next) sessionOperationQueues.delete(sessionId)
 })
 return next
}

/** The agent loop rejects maintenance work while a turn is streaming. */
const AGENT_BUSY_MARKER = 'already has active work'

/** Bounded TTL cache for value-level timeline projections. */
const TIMELINE_CACHE_TTL_MS = 5_000
const TIMELINE_CACHE_MAX = 50

interface TimelineCacheEntry {
 key: string
 result: MessageEditTimeline
 time: number
}

const timelineCache = new Map<string, TimelineCacheEntry>()

/** Invalidate one session's cached projection (call on POST). */
function invalidateTimelineCache(sessionId: string): void {
 timelineCache.delete(sessionId)
}

function timelineCacheKey(sessionId: string, lineage: Array<{ record: SessionRecord }>, currentLength: number): string {
 const nodes = lineage.map(({ record }) => {
  const live = record.header.id === sessionId ? String(currentLength) : ''
  return `${record.header.id}:${record.header.seedLength ?? 0}:${record.header.createdAt}:${live}`
 }).join('|')
 return nodes
}

function cacheTimeline(sessionId: string, key: string, result: MessageEditTimeline): void {
 if (timelineCache.size >= TIMELINE_CACHE_MAX) {
  const oldest = timelineCache.keys().next().value
  if (oldest !== undefined) timelineCache.delete(oldest)
 }
 timelineCache.set(sessionId, { key, result, time: Date.now() })
}

function cachedTimeline(sessionId: string, key: string): MessageEditTimeline | undefined {
 const entry = timelineCache.get(sessionId)
 if (entry === undefined || entry.key !== key) return undefined
 if (Date.now() - entry.time > TIMELINE_CACHE_TTL_MS) {
  timelineCache.delete(sessionId)
  return undefined
 }
 return entry.result
}

type UserEvent = SessionEvent<'user/message'>
type AssistantEvent = SessionEvent<'assistant/message'>

interface ClosedTurn {
 turn: number
 startSeq: number
 endSeq: number
 user?: UserEvent
 assistants: AssistantEvent[]
}

interface ManualAssistantTurn {
 turn: number
 user: UserMessage
 assistant: AssistantMessage
}

interface OperationPlan {
 boundary: number
 version: MessageEditVersionEvent
 manualTurn?: ManualAssistantTurn
 queuedUsers: UserMessage[]
}

interface VersionProjection {
 effect: MessageEditEffect
 inverseSessionId: string
 time: number
}

type MessageEditEffectDraft = Omit<MessageEditEffect, 'id'>

function pairVersionEffect(
 sourceSessionId: string,
 effect: MessageEditEffectDraft,
): MessageEditVersionEvent {
 return {
  schemaVersion: MESSAGE_EDIT_VERSION_SCHEMA,
  effect: { ...effect, id: crypto.randomUUID() },
  inverse: { kind: 'restore-version', sessionId: sourceSessionId },
 }
}

function isTextualBlock(block: ContentBlock | undefined): block is Extract<ContentBlock, { type: 'text' | 'reasoning' }> {
 return block?.type === 'text' || block?.type === 'reasoning'
}

function userText(message: UserMessage): string {
 return message.content
  .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
  .map(block => block.text)
  .join('\n')
}

function cloneUser(message: UserMessage, content: ContentBlock[] = structuredClone(message.content)): UserMessage {
 return Object.freeze({
  id: crypto.randomUUID(),
  role: 'user' as const,
  content: Object.freeze(content),
  source: Object.freeze({ kind: 'user' as const }),
 }) as UserMessage
}

function replaceTextBlock(content: readonly ContentBlock[], blockIndex: number, text: string): ContentBlock[] {
 const block = content[blockIndex]
 if (!isTextualBlock(block)) throw new Error('Selected block is not editable text.')
 return content.map((candidate, index) => index === blockIndex
  ? { ...candidate, text } as ContentBlock
  : structuredClone(candidate))
}

/** Fold complete turn brackets; an open tail is deliberately absent. */
function closedTurns(events: readonly SessionEvent[]): ClosedTurn[] {
 const result: ClosedTurn[] = []
 let current: Omit<ClosedTurn, 'endSeq'> | undefined
 for (const event of events) {
  if (event.type === 'turn/start') {
   current = {
    turn: event.data.turn,
    startSeq: event.seq,
    assistants: [],
   }
   continue
  }
  if (current === undefined) continue
  if (event.type === 'user/message'
   && current.user === undefined
   && event.data.source.kind === 'user') {
   current.user = event
   continue
  }
  if (event.type === 'assistant/message' && event.data.turn === current.turn) {
   current.assistants.push(event)
   continue
  }
  if (event.type === 'turn/end' && event.data.turn === current.turn) {
   result.push({ ...current, endSeq: event.seq })
   current = undefined
  }
 }
 return result
}

function editableMessages(turns: readonly ClosedTurn[]): EditableMessageBlock[] {
 const result: EditableMessageBlock[] = []
 for (const turn of turns) {
  if (turn.user !== undefined) {
   for (const [blockIndex, block] of turn.user.data.content.entries()) {
    if (block.type !== 'text') continue
    result.push({
     key: `${String(turn.user.seq)}:${String(blockIndex)}`,
     turn: turn.turn,
     eventSeq: turn.user.seq,
     blockIndex,
     kind: 'user',
     text: block.text,
     time: turn.user.time,
    })
   }
  }
  for (const event of turn.assistants) {
   for (const [blockIndex, block] of event.data.message.content.entries()) {
    if (!isTextualBlock(block)) continue
    result.push({
     key: `${String(event.seq)}:${String(blockIndex)}`,
     turn: turn.turn,
     eventSeq: event.seq,
     blockIndex,
     kind: block.type === 'reasoning' ? 'assistant.reasoning' : 'assistant.response',
     text: block.text,
     time: event.time,
    })
   }
  }
 }
 return result
}

function retryableTurns(turns: readonly ClosedTurn[]): RetryableTurn[] {
 return turns.flatMap((turn): RetryableTurn[] => turn.user === undefined ? [] : [{
  turn: turn.turn,
  userEventSeq: turn.user.seq,
  preview: userText(turn.user.data),
  time: turn.user.time,
 }])
}

function downstreamUsers(turns: readonly ClosedTurn[], start: number): UserMessage[] {
 return turns.slice(start).flatMap((turn): UserMessage[] => turn.user === undefined
  ? []
  : [cloneUser(turn.user.data)])
}

function assistantReplacement(event: AssistantEvent, blockIndex: number, text: string): AssistantMessage {
 const replaced = replaceTextBlock(event.data.message.content, blockIndex, text)
  .filter(block => block.type === 'text' || block.type === 'reasoning')
 return Object.freeze({
  id: crypto.randomUUID(),
  role: 'assistant' as const,
  content: Object.freeze(replaced),
  source: Object.freeze({
   kind: 'model' as const,
   provider: event.data.message.source.provider,
   model: event.data.message.source.model,
  }),
 }) as AssistantMessage
}

function editPlan(operation: EditOperation, turns: readonly ClosedTurn[]): OperationPlan {
 const turnIndex = turns.findIndex(turn => operation.eventSeq > turn.startSeq && operation.eventSeq < turn.endSeq)
 const turn = turns[turnIndex]
 if (turn === undefined) throw new Error('Selected message does not belong to a settled turn.')
 const event = turn.user?.seq === operation.eventSeq
  ? turn.user
  : turn.assistants.find(candidate => candidate.seq === operation.eventSeq)
 if (event === undefined) throw new Error('Selected message not found or not editable.')

 if (event.type === 'user/message') {
  const before = event.data.content[operation.blockIndex]
  if (before?.type !== 'text') throw new Error('Selected user message block is not text.')
  const edited = cloneUser(event.data, replaceTextBlock(event.data.content, operation.blockIndex, operation.text))
  const later = operation.cascade === 'preserve'
    ? downstreamUsers(turns, turnIndex + 1).slice(0, MAX_PRESERVE_QUEUE - 1)
    : []
  return {
   boundary: turn.startSeq - 1,
   version: pairVersionEffect(operation.sessionId, {
    operation: 'edit',
    cascade: operation.cascade,
    targetTurn: turn.turn,
    targetEventSeq: event.seq,
    targetBlockIndex: operation.blockIndex,
    blockKind: 'user',
    before: before.text,
    after: operation.text,
   }),
   queuedUsers: [edited, ...later],
  }
 }

 const before = event.data.message.content[operation.blockIndex]
 if (!isTextualBlock(before)) throw new Error('Selected assistant block is not text or reasoning.')
 const blockKind: EditableBlockKind = before.type === 'reasoning'
  ? 'assistant.reasoning'
  : 'assistant.response'
 if (turn.user === undefined) throw new Error('Selected assistant message has no reconstructible user input.')
 return {
  boundary: turn.startSeq - 1,
  version: pairVersionEffect(operation.sessionId, {
   operation: 'edit',
   cascade: operation.cascade,
   targetTurn: turn.turn,
   targetEventSeq: event.seq,
   targetBlockIndex: operation.blockIndex,
   blockKind,
   before: before.text,
   after: operation.text,
  }),
  manualTurn: {
   turn: turn.turn,
   user: cloneUser(turn.user.data),
   assistant: assistantReplacement(event, operation.blockIndex, operation.text),
  },
  queuedUsers: operation.cascade === 'preserve'
   ? downstreamUsers(turns, turnIndex + 1)
   : [],
 }
}

function retryPlan(
 sessionId: string,
 turnNumber: number,
 cascade: CascadePolicy,
 turns: readonly ClosedTurn[],
): OperationPlan {
 const turnIndex = turns.findIndex(turn => turn.turn === turnNumber)
 const turn = turns[turnIndex]
 if (turn?.user === undefined) throw new Error('Selected turn has no replayable user input.')
 return {
  boundary: turn.startSeq - 1,
  version: pairVersionEffect(sessionId, {
   operation: 'retry',
   cascade,
   targetTurn: turn.turn,
   targetEventSeq: turn.user.seq,
  }),
  queuedUsers: cascade === 'preserve'
   ? downstreamUsers(turns, turnIndex).slice(0, MAX_PRESERVE_QUEUE)
   : [cloneUser(turn.user.data)],
 }
}

function rerollPlan(sessionId: string, turns: readonly ClosedTurn[]): OperationPlan {
 for (let index = turns.length - 1; index >= 0; index -= 1) {
  const turn = turns[index]
  if (turn?.user === undefined) continue
  const target = turn.assistants.findLast(event => event.data.message.content.some(isTextualBlock))
  if (target === undefined) continue
  return {
   boundary: turn.startSeq - 1,
   version: pairVersionEffect(sessionId, {
    operation: 'reroll',
    cascade: 'truncate',
    targetTurn: turn.turn,
    targetEventSeq: target.seq,
   }),
   queuedUsers: [cloneUser(turn.user.data)],
  }
 }
 throw new Error('Current session has no settled assistant reply to regenerate.')
}

/** Branch plan that ends just before the deleted exchange (fork fallback for
 * sessions without a live agent; the original session keeps its history). */
function deletePlan(operation: DeleteOperation, turns: readonly ClosedTurn[]): OperationPlan {
 const turn = turns.find(candidate => candidate.user?.seq === operation.eventSeq)
 if (turn === undefined) throw new Error('Selected message is not a settled user message.')
 return {
  boundary: turn.startSeq - 1,
  version: pairVersionEffect(operation.sessionId, {
   operation: 'delete',
   cascade: 'truncate',
   targetTurn: turn.turn,
   targetEventSeq: operation.eventSeq,
   blockKind: 'user',
   ...(turn.user === undefined ? {} : { before: userText(turn.user.data) }),
  }),
  queuedUsers: [],
 }
}

function planOperation(operation: MessageEditOperation, events: readonly SessionEvent[]): OperationPlan {
 const turns = closedTurns(events)
 switch (operation.action) {
  case 'edit':
   return editPlan(operation, turns)
  case 'reroll':
   return rerollPlan(operation.sessionId, turns)
  case 'retry':
   return retryPlan(operation.sessionId, operation.turn, operation.cascade, turns)
  case 'delete':
   return deletePlan(operation, turns)
 }
}

function agentOptions(events: readonly SessionEvent[], fallback?: AgentOptions): AgentOptions {
 const config = events.findLast(event => event.type === 'request/header')?.data.header.config
 const provider = config?.provider ?? fallback?.provider
 const model = config?.model ?? fallback?.model
 if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
  throw new Error('Unable to resolve model route from session history.')
 }
 const maxTokens = config?.maxTokens ?? fallback?.maxTokens
 return {
  provider,
  model,
  ...maxTokens === undefined ? {} : { maxTokens },
 }
}

async function withSourceAgent<T>(
 ctx: Context,
 sessionId: SessionId,
 operation: (agent: Agent) => Promise<T>,
): Promise<T> {
 let handle: AgentHandle | undefined
 let agent = ctx.agents.get(sessionId)
 if (agent === undefined) {
  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  handle = await ctx.agents.resume({
   resumeSessionId: sessionId,
   agentOptions: agentOptions(snapshot.events),
  })
  agent = handle.agent
 }
 try {
  return await agent.runMaintenance(async () => operation(agent))
 } finally {
  await handle?.dispose()
 }
}

function inheritedSeed(source: Session, boundary: number): SessionEvent[] {
 if (boundary === -1) return []
 const boundaryEvent = source.events[boundary]
 if (boundary < 0 || boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
  throw new Error('Branch boundary is not a contiguous session event.')
 }
 return source.events.slice(0, boundary + 1)
}

/** Build seed envelopes locally; Session construction performs canonical validation and freezing. */
function appendLogSeedEvent<T extends Exclude<SessionEventType, SurfaceEventType>>(
 events: SessionEvent[],
 type: T,
 data: SessionEvent<T>['data'],
): void {
 events.push({ type, seq: events.length, time: Date.now(), data } as SessionEvent<T>)
}

function appendSurfaceSeedEvent<T extends SurfaceEventType>(
 events: SessionEvent[],
 type: T,
 data: SessionEvent<T>['data'],
 intent: SurfaceIntent,
): void {
 events.push({
  type,
  seq: events.length,
  time: Date.now(),
  data,
  surfaceOp: intent.surfaceOp,
  ...intent.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: intent.sourceEventSeqs },
 } as SessionEvent<T>)
}

function appendManualTurn(events: SessionEvent[], manual: ManualAssistantTurn): void {
 const { turn, user, assistant } = manual
 appendLogSeedEvent(events, 'turn/start', { turn })
 appendSurfaceSeedEvent(events, 'user/message', user, { surfaceOp: 'append' })
 appendLogSeedEvent(events, 'step/start', { turn, step: 1 })
 appendSurfaceSeedEvent(events, 'assistant/message', { turn, step: 1, message: assistant }, {
  surfaceOp: 'append',
  sourceEventSeqs: [],
 })
 appendLogSeedEvent(events, 'step/end', { turn, step: 1 })
 appendLogSeedEvent(events, 'turn/end', { turn, reason: { kind: 'completed' } })
}

function versionSeed(source: Session, plan: OperationPlan): {
 events: SessionEvent[]
 inheritedLength: number
} {
 const events = inheritedSeed(source, plan.boundary)
 const inheritedLength = events.length
  appendLogSeedEvent(events, 'message-edit-enhanced/version', plan.version)
 if (plan.manualTurn !== undefined) appendManualTurn(events, plan.manualTurn)
 return { events, inheritedLength }
}

function sessionPreset(session: PresetBearingSession): string | undefined {
 for (let index = session.events.length - 1; index >= 0; index -= 1) {
  const event = session.events[index]
  if (event?.type === 'agent-preset/selected') return event.data.agentPreset
 }
 return session.header.agentPreset
}

async function createVersionAgent(
 ctx: Context,
 source: Session,
 childId: SessionId,
 plan: OperationPlan,
 options: AgentOptions,
): Promise<AgentHandle> {
 const seed = versionSeed(source, plan)
 const presets = ctx.get('agentPresets')
 const presetId = sessionPreset(source)
 let agentPreset: string | undefined
 let setup: AgentSetup | undefined
 if (presets !== undefined && presetId !== undefined) {
  const resolved = (await presets.resolve(presetId)).id
  agentPreset = resolved
  setup = async (agentCtx) => { await presets.mount(agentCtx, resolved) }
 }
 const child = await ctx.agents.create({
  sessionId: childId,
  seed: seed.events,
  meta: {
   ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
   parentSession: source.id,
   seedLength: seed.inheritedLength,
   ...agentPreset === undefined ? {} : { agentPreset },
  },
  agentOptions: options,
  ...setup === undefined ? {} : { setup },
 })
 try {
  await ctx.sessions.flush(child.agent.session)
  return child
 } catch (error: unknown) {
  await child.dispose()
  throw error
 }
}

function sourceWorkspace(ctx: Context, sessionId: SessionId): Workspace | undefined {
 return ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(sessionId))
}

type OperationInverse = () => void | Promise<void>

async function recoverOperation(inverses: OperationInverse[]): Promise<void> {
 const failures: unknown[] = []
 for (const inverse of inverses.reverse()) {
  try {
   await inverse()
  } catch (error: unknown) {
   failures.push(error)
  }
 }
 if (failures.length > 0) throw new AggregateError(failures, 'Failed to recover version operation.')
}

function isInPlaceEligible(ctx: Context, sourceId: SessionId, operation: EditOperation): boolean {
 const sourceSession = ctx.sessions.get(sourceId)
 if (sourceSession === undefined) return false
 const agent = ctx.agents.get(sourceId)
 if (agent === undefined) return false
 const target = sourceSession.events[operation.eventSeq]
 if (target?.type !== 'user/message') return false
 return sourceSession.surface.nodes.includes(operation.eventSeq)
}

async function runInPlaceEdit(
 ctx: Context,
 sourceId: SessionId,
 operation: EditOperation,
): Promise<MessageEditOperationResult> {
 const agent = ctx.agents.get(sourceId)
 if (agent === undefined) throw new Error('Session agent is not live; cannot edit in place.')
 return agent.runMaintenance(async () => {
  const session = agent.session
  const events = session.events
  const turns = closedTurns(events)
  const turnIndex = turns.findIndex(turn => operation.eventSeq > turn.startSeq && operation.eventSeq < turn.endSeq)
  const turn = turns[turnIndex]
  if (turn === undefined) throw new Error('Selected message does not belong to a settled turn.')
  const target = turn.user?.seq === operation.eventSeq ? turn.user : undefined
  if (target?.type !== 'user/message') throw new Error('In-place edit requires a user message.')
  const before = target.data.content[operation.blockIndex]
  if (before?.type !== 'text') throw new Error('Selected user message block is not text.')
  const edited = cloneUser(target.data, replaceTextBlock(target.data.content, operation.blockIndex, operation.text))

  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(operation.eventSeq)
  if (startIdx === -1) throw new Error('Target message is no longer on the conversation surface.')
  const shadowed = nodes.slice(startIdx)
  const start = shadowed[0]
  const end = shadowed[shadowed.length - 1]
  if (start === undefined || end === undefined) throw new Error('Target message has no surface span to truncate.')

  const options = agentOptions(events, agent.options)
  const provider = options.provider
  const model = options.model
  if (provider === undefined || model === undefined) throw new Error('Unable to resolve model route for in-place edit.')
  const nextTurn = (turns.at(-1)?.turn ?? 0) + 1
  const emptyMessage = Object.freeze({
   id: crypto.randomUUID() as unknown as AssistantMessage['id'],
   role: 'assistant' as const,
   content: Object.freeze([] as ContentBlock[]),
   source: Object.freeze({ kind: 'model' as const, provider, model }),
  }) as AssistantMessage
  session.append('assistant/message', {
   turn: nextTurn,
   step: 1,
   message: emptyMessage,
  }, {
   surfaceOp: { op: 'replace', start, end },
   sourceEventSeqs: [...shadowed],
  })
  // Queue the regeneration BEFORE flushing, so a failed flush never strands
  // a truncated surface without a queued response.
  agent.followup(edited)
  try {
   await ctx.sessions.flush(session)
  } catch (error) {
   // Durability hiccup: the regeneration is already queued and the loop will
   // persist the turn on the next boundary. Log and continue.
   console.warn('In-place edit: flush failed, regeneration continues in memory.', error)
  }
  return { sessionId: session.id, queuedTurns: 1 }
 })
}

async function runForkOperation(
 ctx: Context,
 source: Agent,
 sourceId: SessionId,
 events: readonly SessionEvent[],
 operation: MessageEditOperation,
): Promise<MessageEditOperationResult> {
 const childId = sessionIdOf(`session-${crypto.randomUUID()}`)
 const inverses: OperationInverse[] = []
 try {
  const plan = planOperation(operation, events)
  const options = agentOptions(events, source.options)
  const child = await createVersionAgent(ctx, source.session, childId, plan, options)
  inverses.push(() => child.dispose())

  const workspace = sourceWorkspace(ctx, sourceId)
  if (workspace !== undefined) {
   await workspace.attachSession(childId)
   inverses.push(() => workspace.detachSession(childId))
  }
  for (const message of plan.queuedUsers) child.agent.followup(message)

  inverses.length = 0
  return { sessionId: childId, queuedTurns: plan.queuedUsers.length }
 } catch (error: unknown) {
  try {
   await recoverOperation(inverses)
  } catch (recoveryError: unknown) {
   throw new AggregateError([error, recoveryError], 'Version operation and its recovery both failed.')
  }
  throw error
 }
}

/** In-place delete requires the same live prerequisites as in-place edit:
 * a live session, a live agent for the followup-free truncation, and the
 * target user message still on the active surface. */
function isInPlaceDeleteEligible(ctx: Context, sourceId: SessionId, operation: DeleteOperation): boolean {
 const sourceSession = ctx.sessions.get(sourceId)
 if (sourceSession === undefined) return false
 if (ctx.agents.get(sourceId) === undefined) return false
 const target = sourceSession.events[operation.eventSeq]
 if (target?.type !== 'user/message') return false
 return sourceSession.surface.nodes.includes(operation.eventSeq)
}

/** Delete a settled user message exchange IN PLACE: truncate the surface from
 * the target message to the end (one empty replacement node, no regeneration),
 * after rolling the workspace back to the checkpoint taken before the message.
 * Rollback-first ordering keeps the conversation untouched when files fail. */
async function runInPlaceDelete(
 ctx: Context,
 sourceId: SessionId,
 operation: DeleteOperation,
): Promise<MessageEditOperationResult> {
 const agent = ctx.agents.get(sourceId)
 if (agent === undefined) throw new Error('Session agent is not live; cannot delete in place.')
 return agent.runMaintenance(async () => {
  const session = agent.session
  const events = session.events
  const turns = closedTurns(events)
  const turnIndex = turns.findIndex(turn => turn.user?.seq === operation.eventSeq)
  const turn = turns[turnIndex]
  if (turn === undefined || turn.user === undefined) {
   // The event exists as a user/message but no settled turn claims it: an
   // earlier replace already shadowed it. Deletion is idempotent here.
   const raw = events[operation.eventSeq]
   if (raw?.type === 'user/message') {
    return { sessionId: session.id, queuedTurns: 0, alreadyDeleted: true }
   }
   throw new Error('Selected message is not a settled user message.')
  }
  const removedTurns = turns.slice(turnIndex).map(candidate => candidate.turn)

  let revertedFiles = 0
  let removedFiles = 0
  let skippedFiles = 0
  let workspaceRolledBack = false
  if (operation.rollbackWorkspace) {
   const plan = await planRollback(ctx, sourceId, operation.eventSeq)
   if (!plan.available || plan.manifest === undefined) {
    throw new Error(`Workspace rollback is not available: ${plan.reason ?? 'no checkpoint'}`)
   }
   const outcome = await applyRollback(ctx, plan, plan.manifest.workspacePath)
   if (outcome.failures.length > 0) {
    const detail = outcome.failures.slice(0, 5).map(f => `${f.path}: ${f.error}`).join('; ')
    throw new Error(
     `Workspace rollback failed on ${String(outcome.failures.length)} file(s); the conversation was left unchanged. `
     + `Retry once file access is restored (${detail}${outcome.failures.length > 5 ? '; …' : ''})`,
    )
   }
   revertedFiles = outcome.reverted
   removedFiles = outcome.removed
   skippedFiles = plan.skipped.length
   workspaceRolledBack = true
  }

  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(operation.eventSeq)
  if (startIdx === -1) throw new Error('Target message is no longer on the conversation surface.')
  const shadowed = nodes.slice(startIdx)
  const start = shadowed[0]
  const end = shadowed[shadowed.length - 1]
  if (start === undefined || end === undefined) throw new Error('Target message has no surface span to delete.')

  const options = agentOptions(events, agent.options)
  const provider = options.provider
  const model = options.model
  if (provider === undefined || model === undefined) throw new Error('Unable to resolve model route for in-place delete.')
  const nextTurn = (turns.at(-1)?.turn ?? 0) + 1
  const emptyMessage = Object.freeze({
   id: crypto.randomUUID() as unknown as AssistantMessage['id'],
   role: 'assistant' as const,
   content: Object.freeze([] as ContentBlock[]),
   source: Object.freeze({ kind: 'model' as const, provider, model }),
  }) as AssistantMessage
  session.append('assistant/message', {
   turn: nextTurn,
   step: 1,
   message: emptyMessage,
  }, {
   surfaceOp: { op: 'replace', start, end },
   sourceEventSeqs: [...shadowed],
  })
  try {
   await ctx.sessions.flush(session)
  } catch (error) {
   console.warn('In-place delete: flush failed; truncation stays in memory until the next boundary.', error)
  }

  const auditId = await appendAuditEntry({
   kind: 'delete',
   sessionId: session.id,
   eventSeq: operation.eventSeq,
   turn: turn.turn,
   removedTurns,
   revertedFiles,
   removedFiles,
   skippedFiles,
   rollbackWorkspace: operation.rollbackWorkspace,
  })

  return {
   sessionId: session.id,
   queuedTurns: 0,
   delete: {
    removedTurns,
    revertedFiles,
    removedFiles,
    skippedFiles,
    workspaceRolledBack,
    auditId,
   },
  }
 })
}

/** Read-only impact report for the confirmation dialog. */
async function deletePreview(ctx: Context, sourceId: SessionId, eventSeq: number): Promise<MessageEditDeletePreview> {
 const events = await readCurrentLog(ctx, sourceId)
 const turns = closedTurns(events)
 const turnIndex = turns.findIndex(turn => turn.user?.seq === eventSeq)
 const turn = turns[turnIndex]
 if (turn === undefined || turn.user === undefined) {
  throw new Error('Selected message is not a settled user message.')
 }
 const laterTurns = turns.slice(turnIndex + 1).map(candidate => candidate.turn)
 const liveSession = ctx.sessions.get(sourceId) !== undefined
 const liveAgent = ctx.agents.get(sourceId) !== undefined
 const preview: MessageEditDeletePreview = {
  sessionId: sourceId,
  eventSeq,
  turn: turn.turn,
  preview: userText(turn.user.data),
  laterTurns,
  willBranch: !liveSession || !liveAgent,
  checkpointFound: false,
  filesToRevert: [],
  filesToRemove: [],
  skipped: [],
  warnings: [],
 }
 if (preview.willBranch) {
  preview.warnings.push('This session is not active right now, so deleting will create a branch without the deleted exchanges instead of truncating this conversation.')
 }
 try {
  const plan = await planRollback(ctx, sourceId, eventSeq)
  if (plan.available && plan.manifest !== undefined) {
   preview.checkpointFound = true
   preview.workspacePath = plan.manifest.workspacePath
   preview.filesToRevert = plan.filesToWrite.map(entry => ({ path: entry.path, change: 'revert' as const }))
   preview.filesToRemove = plan.filesToRemove.map(path => ({ path, change: 'remove' as const }))
   preview.skipped = plan.skipped
   preview.warnings.push(...plan.warnings)
  } else {
   if (plan.reason !== undefined) preview.checkpointReason = plan.reason
   preview.warnings.push('No pre-message workspace snapshot exists, so code changes from this exchange cannot be reverted automatically.')
  }
 } catch (error) {
  preview.checkpointReason = error instanceof Error ? error.message : String(error)
  preview.warnings.push('The workspace could not be inspected for a rollback plan.')
 }
 return preview
}

export async function runOperation(ctx: Context, operation: MessageEditOperation): Promise<MessageEditOperationResult> {
 const sourceId = sessionIdOf(operation.sessionId)
 if (operation.action === 'delete') {
  if (isInPlaceDeleteEligible(ctx, sourceId, operation)) {
   return runInPlaceDelete(ctx, sourceId, operation)
  }
  return withSourceAgent(ctx, sourceId, async (source) => runForkOperation(ctx, source, sourceId, source.session.events, operation))
 }
 if (operation.action === 'edit' && isInPlaceEligible(ctx, sourceId, operation)) {
  return runInPlaceEdit(ctx, sourceId, operation)
 }
 return withSourceAgent(ctx, sourceId, async (source) => runForkOperation(ctx, source, sourceId, source.session.events, operation))
}

function ownVersionEvent(
  header: SessionRecord['header'],
  events: readonly SessionEvent[],
): VersionProjection | undefined {
  const inherited = header.seedLength ?? 0
  const ownEvents = events.filter((event): event is SessionEvent<'message-edit-enhanced/version'> => (
    event.type === 'message-edit-enhanced/version' && event.seq >= inherited
  ))
 if (ownEvents.length === 0) return undefined
 if (ownEvents.length > 1) {
  throw new Error(`Session ${header.id} contains multiple own version effects.`)
 }
 const event = ownEvents[0]
 if (event === undefined) return undefined
 const parent = header.parentSession
 if ('schemaVersion' in event.data) {
  const version = event.data
  if (version.schemaVersion !== MESSAGE_EDIT_VERSION_SCHEMA) {
   throw new Error(`Session ${header.id} uses an unsupported version effect schema.`)
  }
  if (version.inverse.kind !== 'restore-version'
   || parent === undefined
   || version.inverse.sessionId !== parent) {
   throw new Error(`Version effect and inverse mismatch for session ${header.id}.`)
  }
  return { effect: version.effect, inverseSessionId: version.inverse.sessionId, time: event.time }
 }

 const legacy: LegacyMessageEditVersionEvent = event.data
 if (parent === undefined || legacy.sourceSessionId !== parent) {
  throw new Error(`Legacy restore target mismatch for session ${header.id}.`)
 }
 return {
  effect: {
   id: `legacy:${header.id}:${String(event.seq)}`,
   operation: legacy.operation,
   cascade: legacy.cascade,
   targetTurn: legacy.targetTurn,
   targetEventSeq: legacy.targetEventSeq,
   ...legacy.targetBlockIndex === undefined ? {} : { targetBlockIndex: legacy.targetBlockIndex },
   ...legacy.blockKind === undefined ? {} : { blockKind: legacy.blockKind },
   ...legacy.before === undefined ? {} : { before: legacy.before },
   ...legacy.after === undefined ? {} : { after: legacy.after },
  },
  inverseSessionId: legacy.sourceSessionId,
  time: event.time,
 }
}

function flattenLineage(
 root: SessionRecord,
 descendants: readonly SessionLineageNode[],
): Array<{ record: SessionRecord; depth: number }> {
 const result: Array<{ record: SessionRecord; depth: number }> = [{ record: root, depth: 0 }]
 const visit = (nodes: readonly SessionLineageNode[], depth: number): void => {
  const ordered = [...nodes].sort((left, right) => (
   left.session.header.createdAt - right.session.header.createdAt
   || String(left.session.header.id).localeCompare(String(right.session.header.id))
  ))
  for (const node of ordered) {
   result.push({ record: node.session, depth })
   visit(node.descendants, depth + 1)
  }
 }
 visit(descendants, 1)
 return result
}

/** Minimal read face of the optional persistence service; borrowed events are
 * consumed synchronously inside one timeline projection. */
interface PersistenceReaderLike {
 inspect(sessionId: SessionId, signal?: AbortSignal): Promise<{ events: readonly SessionEvent[] }>
 readFrom(sessionId: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ events: readonly SessionEvent[] }>
}

/** Bounded parallel inspection of persisted branches; matches the corpus worker shape. */
const TIMELINE_READ_CONCURRENCY = 4

async function mapConcurrent<T, R>(
 items: readonly T[],
 worker: (item: T) => Promise<R>,
): Promise<R[]> {
 const results = new Array<R>(items.length)
 let cursor = 0
 const run = async (): Promise<void> => {
  for (;;) {
   const index = cursor
   cursor += 1
   if (index >= items.length) return
   results[index] = await worker(items[index] as T)
  }
 }
 const workers = Math.min(TIMELINE_READ_CONCURRENCY, items.length)
 await Promise.all(Array.from({ length: workers }, () => run()))
 return results
}

/** Full log for the requested session: live borrow, persisted inspection, query fallback. */
async function readCurrentLog(ctx: Context, sessionId: SessionId): Promise<readonly SessionEvent[]> {
 const live = ctx.sessions.get(sessionId)
 if (live !== undefined) return live.events
 const persistence = ctx.get('sessionPersistence') as PersistenceReaderLike | undefined
 if (persistence !== undefined) return (await persistence.inspect(sessionId)).events
 return (await ctx.sessionQuery.readSession(sessionId)).events
}

/** Own-version scan window for one lineage node: the tail from the durable
 * seed boundary is enough, and root nodes cannot carry a version effect. */
async function versionLog(ctx: Context, record: SessionRecord): Promise<readonly SessionEvent[]> {
 const inherited = record.header.seedLength ?? 0
 const live = ctx.sessions.get(record.header.id)
 if (live !== undefined) return live.events.slice(inherited)
 const persistence = ctx.get('sessionPersistence') as PersistenceReaderLike | undefined
 if (persistence !== undefined) return (await persistence.readFrom(record.header.id, inherited)).events
 return (await ctx.sessionQuery.readSession(record.header.id)).events.slice(inherited)
}

async function timeline(ctx: Context, sessionId: SessionId): Promise<MessageEditTimeline> {
 const targetTrace = await ctx.sessionQuery.traceSession(sessionId)
 const rootId = targetTrace.complete
  ? targetTrace.root.header.id
  : targetTrace.ancestors.at(-1)?.header.id ?? sessionId
 const rootTrace = rootId === sessionId ? targetTrace : await ctx.sessionQuery.traceSession(rootId)
 const lineage = flattenLineage(rootTrace.target, rootTrace.descendants)

 const liveCurrent = ctx.sessions.get(sessionId)
 const currentLength = liveCurrent !== undefined ? liveCurrent.events.length : -1
 const cacheable = liveCurrent !== undefined && sessionId === rootId
 if (cacheable) {
  const key = timelineCacheKey(sessionId, lineage, currentLength)
  const hit = cachedTimeline(sessionId, key)
  if (hit !== undefined) return hit
 }

 const logs = await mapConcurrent(lineage, async ({ record }): Promise<readonly SessionEvent[]> => {
  if (record.header.id === sessionId) return readCurrentLog(ctx, sessionId)
  if (record.header.parentSession === undefined) return []
  return versionLog(ctx, record)
 })
 const recordsById = new Map(lineage.map(({ record }) => [record.header.id, record]))
 const currentPath = new Set<SessionId>()
 let pathId: SessionId | undefined = sessionId
 while (pathId !== undefined && !currentPath.has(pathId)) {
  currentPath.add(pathId)
  pathId = recordsById.get(pathId)?.header.parentSession
 }

 const versions: VersionSummary[] = lineage.map(({ record, depth }, index) => {
  const version = ownVersionEvent(record.header, logs[index] ?? [])
  return {
   sessionId: record.header.id,
   ...record.header.parentSession === undefined ? {} : { parentSessionId: record.header.parentSession },
   ...version === undefined ? {} : {
    effectId: version.effect.id,
    inverseSessionId: version.inverseSessionId,
   },
   createdAt: version?.time ?? record.header.createdAt,
   depth,
   current: record.header.id === sessionId,
   onCurrentEffectPath: currentPath.has(record.header.id),
   ...version === undefined ? {} : {
    operation: version.effect.operation,
    cascade: version.effect.cascade,
    targetTurn: version.effect.targetTurn,
    ...version.effect.blockKind === undefined ? {} : { blockKind: version.effect.blockKind },
    ...version.effect.before === undefined ? {} : { before: version.effect.before },
    ...version.effect.after === undefined ? {} : { after: version.effect.after },
   },
  }
 })
 const effectIds = new Set<string>()
 for (const version of versions) {
  if (version.effectId === undefined) continue
  if (effectIds.has(version.effectId)) throw new Error(`Version effect ${version.effectId} is duplicated.`)
  effectIds.add(version.effectId)
 }

 const versionsById = new Map(versions.map(version => [version.sessionId, version]))
 const undoStack: string[] = []
 let undoCursor = versionsById.get(sessionId)
 while (undoCursor?.inverseSessionId !== undefined) {
  const inverseId = undoCursor.inverseSessionId
  if (undoStack.includes(inverseId)) throw new Error('Version effect inverse chain contains a cycle.')
  if (!versionsById.has(inverseId)) throw new Error(`Restore target ${inverseId} not in visible version tree.`)
  undoStack.push(inverseId)
  undoCursor = versionsById.get(inverseId)
 }
 const redoSessionIds = versions
  .filter(version => version.inverseSessionId === sessionId)
  .map(version => version.sessionId)

 const currentIndex = versions.findIndex(version => version.current)
 const currentLog = logs[currentIndex]
 if (currentIndex < 0 || currentLog === undefined) throw new Error('Current version not in version tree.')
 const turns = closedTurns(currentLog)
 const result: MessageEditTimeline = {
  sessionId,
  messages: editableMessages(turns),
  retryableTurns: retryableTurns(turns),
  versions,
  undoStack,
  redoSessionIds,
 }
 if (cacheable) {
  cacheTimeline(sessionId, timelineCacheKey(sessionId, lineage, currentLength), result)
 }
 return result
}

function objectValue(value: unknown): Record<string, unknown> {
 if (typeof value !== 'object' || value === null || Array.isArray(value)) {
  throw new TypeError('Request body must be a JSON object.')
 }
 return value as Record<string, unknown>
}

function sessionIdOf(value: unknown): SessionId {
 if (typeof value !== 'string' || value.length === 0) throw new TypeError('sessionId must be a non-empty string.')
 return value as SessionId
}

function integerOf(value: unknown, name: string): number {
 if (!Number.isSafeInteger(value) || (value as number) < 0) {
  throw new TypeError(`${name} must be a non-negative safe integer.`)
 }
 return value as number
}

function cascadeOf(value: unknown): CascadePolicy {
 if (value !== 'truncate' && value !== 'preserve') throw new TypeError("cascade must be 'truncate' or 'preserve'.")
 return value
}

function decodeOperation(value: unknown): MessageEditOperation {
 const record = objectValue(value)
 const sessionId = sessionIdOf(record['sessionId'])
 switch (record['action']) {
  case 'edit':
   if (typeof record['text'] !== 'string') throw new TypeError('text must be a string.')
   return {
    action: 'edit',
    sessionId,
    eventSeq: integerOf(record['eventSeq'], 'eventSeq'),
    blockIndex: integerOf(record['blockIndex'], 'blockIndex'),
    text: record['text'],
    cascade: cascadeOf(record['cascade']),
   }
  case 'reroll':
   return { action: 'reroll', sessionId }
  case 'retry':
   return {
    action: 'retry',
    sessionId,
    turn: integerOf(record['turn'], 'turn'),
    cascade: cascadeOf(record['cascade']),
   }
  case 'delete':
   return {
    action: 'delete',
    sessionId,
    eventSeq: integerOf(record['eventSeq'], 'eventSeq'),
    rollbackWorkspace: record['rollbackWorkspace'] !== false,
   }
  default:
   throw new TypeError("action must be 'edit', 'reroll', 'retry', or 'delete'.")
 }
}

function requestJson(request: HttpRequestLike): Promise<unknown> {
 return new Promise((resolve, reject) => {
  const decoder = new TextDecoder()
  let text = ''
  request.on('data', (chunk) => {
   text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  })
  request.on('end', () => {
   try {
    text += decoder.decode()
    resolve(JSON.parse(text) as unknown)
   } catch (error) {
    reject(error)
   }
  })
  request.on('error', reject)
 })
}

function respondJson(response: HttpResponseLike, status: number, value: unknown): void {
 response.writeHead(status, {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
 })
 response.end(JSON.stringify(value))
}

/** Serve GET <MESSAGE_EDIT_PATH>/delete-preview for the confirmation dialog. */
async function handleDeletePreviewRoute(ctx: Context, request: HttpRequestLike, response: HttpResponseLike): Promise<void> {
 try {
  const url = new URL(request.url ?? MESSAGE_EDIT_PATH, 'http://message-edit-enhanced.local')
  const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
  const eventSeq = integerOf(Number.parseInt(url.searchParams.get('eventSeq') ?? '', 10), 'eventSeq')
  respondJson(response, 200, await deletePreview(ctx, sessionId, eventSeq))
 } catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  respondJson(response, error instanceof TypeError ? 400 : 409, { error: message })
 }
}

async function handleRoute(ctx: Context, request: HttpRequestLike, response: HttpResponseLike): Promise<void> {
  try {
    if (request.method === 'GET') {
      const url = new URL(request.url ?? MESSAGE_EDIT_PATH, 'http://message-edit-enhanced.local')
   const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
   respondJson(response, 200, await timeline(ctx, sessionId))
   return
  }
  if (request.method === 'POST') {
   const operation = decodeOperation(await requestJson(request))
   const sourceId = sessionIdOf(operation.sessionId)
   const result = await serializeSessionOperation(sourceId, () => runOperation(ctx, operation))
   invalidateTimelineCache(sourceId)
   if (result.sessionId !== sourceId) invalidateTimelineCache(result.sessionId)
   respondJson(response, 200, result)
   return
  }
  response.writeHead(405)
  response.end()
 } catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const busy = message.includes(AGENT_BUSY_MARKER)
  respondJson(response, error instanceof TypeError ? 400 : 409, {
   error: busy ? 'The assistant is still responding; wait for it to finish before editing.' : message,
   ...busy ? { code: 'agent-busy' } : {},
  })
 }
}

/** Register the reversible route contributions and the checkpoint capture feed. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MESSAGE_EDIT_PATH,
    handler: (request, response) => handleRoute(ctx, request, response),
  }), 'message-edit-enhanced: HTTP route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${MESSAGE_EDIT_PATH}/delete-preview`,
    handler: (request, response) => handleDeletePreviewRoute(ctx, request, response),
  }), 'message-edit-enhanced: delete-preview route')
  // Capture a pre-message workspace checkpoint whenever any session appends a
  // user message. Post-commit and asynchronous: never blocks or fails the feed.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
   if (event.type !== 'user/message') return
   if (event.data.source?.kind !== 'user') return
   captureCheckpoint(ctx, session.id, event.seq)
  }), 'message-edit-enhanced: workspace checkpoint capture')
}
