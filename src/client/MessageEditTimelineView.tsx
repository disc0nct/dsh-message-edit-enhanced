/** Timeline tab: durable version tree plus turn/block edit and retry controls. */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CascadePolicy,
  EditableBlockKind,
  EditableMessageBlock,
  MessageEditDeletePreview,
  RetryableTurn,
  VersionOperation,
  VersionSummary,
} from '../shared.ts'
import type { MessageEditFace } from './controller.ts'
import styles from './MessageEditTimelineView.module.css'

/** Word-level diff result. */
interface DiffChunk {
  type: 'equal' | 'delete' | 'insert'
  value: string
}

/** Compute a simple word-level diff between two strings. */
function computeDiff(before: string, after: string): DiffChunk[] {
  const beforeWords = before.split(/(\s+)/)
  const afterWords = after.split(/(\s+)/)

  const m = beforeWords.length
  const n = afterWords.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const prevRow = dp[i - 1]
      const currRow = dp[i]
      if (prevRow === undefined || currRow === undefined) continue
      const bw = beforeWords[i - 1]
      const aw = afterWords[j - 1]
      if (bw !== undefined && aw !== undefined && bw === aw) {
        const prev = prevRow[j - 1]
        if (prev !== undefined) currRow[j] = prev + 1
      } else {
        const a = prevRow[j] ?? 0
        const b = currRow[j - 1] ?? 0
        currRow[j] = Math.max(a, b)
      }
    }
  }

  const chunks: DiffChunk[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    const currRow = dp[i]
    const prevRow = dp[i - 1]
    if (currRow === undefined || prevRow === undefined) break
    const bw = i > 0 ? beforeWords[i - 1] : undefined
    const aw = j > 0 ? afterWords[j - 1] : undefined
    if (i > 0 && j > 0 && bw !== undefined && aw !== undefined && bw === aw) {
      chunks.unshift({ type: 'equal', value: bw })
      i--
      j--
    } else if (j > 0 && (i === 0 || (currRow[j] ?? 0) >= (prevRow[j - 1] ?? 0))) {
      chunks.unshift({ type: 'insert', value: aw ?? '' })
      j--
    } else {
      chunks.unshift({ type: 'delete', value: bw ?? '' })
      i--
    }
  }

  // Merge adjacent chunks of same type
  const merged: DiffChunk[] = []
  for (const chunk of chunks) {
    const last = merged[merged.length - 1]
    if (last && last.type === chunk.type) {
      last.value += chunk.value
    } else {
      merged.push({ ...chunk })
    }
  }
  return merged
}

type MessageEditTimelineViewProps = ConvViewProps & InjectFace<MessageEditFace>

interface TurnSection {
  retry: RetryableTurn
  messages: EditableMessageBlock[]
}

interface EditingState {
  message: EditableMessageBlock
  text: string
}

interface VersionMeta {
  pinned: boolean
  tags: string[]
  note: string
}

type StoredVersionMeta = Record<string, VersionMeta>

type ActiveFilter = 'all' | VersionOperation | 'current' | 'on-path' | 'pinned'

const BLOCK_LABEL: Record<EditableBlockKind, string> = {
  user: 'User Message',
  'assistant.reasoning': 'Assistant Reasoning',
  'assistant.response': 'Assistant Response',
}

const OPERATION_LABEL: Record<Exclude<VersionOperation, undefined>, string> = {
  edit: 'Edit',
  reroll: 'Reroll',
  retry: 'Retry',
  delete: 'Delete',
}

const FILTER_LABEL: Record<ActiveFilter, string> = {
  all: 'All',
  edit: 'Edit',
  reroll: 'Reroll',
  retry: 'Retry',
  delete: 'Delete',
  current: 'Current',
  'on-path': 'On Path',
  pinned: 'Pinned',
}

const META_STORAGE_KEY = 'dsh-message-edit-enhanced:version-meta'

function loadVersionMeta(): StoredVersionMeta {
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveVersionMeta(meta: StoredVersionMeta): void {
  try {
    localStorage.setItem(META_STORAGE_KEY, JSON.stringify(meta))
  } catch {
    // quota exceeded, etc.
  }
}

function getVersionMeta(versionId: string, meta: StoredVersionMeta): VersionMeta {
  return meta[versionId] ?? { pinned: false, tags: [], note: '' }
}

function updateVersionMeta(
  versionId: string,
  updates: Partial<VersionMeta>,
  meta: StoredVersionMeta,
): StoredVersionMeta {
  const next = {
    ...meta,
    [versionId]: { ...getVersionMeta(versionId, meta), ...updates },
  }
  saveVersionMeta(next)
  return next
}

function timeLabel(value: number): string {
  return new Date(value).toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function matchesFilter(version: VersionSummary, filter: ActiveFilter, pinnedMeta: StoredVersionMeta): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'current':
      return version.current
    case 'on-path':
      return version.onCurrentEffectPath
    case 'pinned':
      return getVersionMeta(version.sessionId, pinnedMeta).pinned
    default:
      return version.operation === filter
  }
}

function matchesSearch(version: VersionSummary, query: string): boolean {
  if (query.length === 0) return true
  const q = query.toLowerCase()
  const fields = [
    version.sessionId,
    version.parentSessionId,
    version.effectId,
    version.inverseSessionId,
    version.operation,
    version.cascade,
    version.before,
    version.after,
    version.targetTurn === undefined ? undefined : String(version.targetTurn),
  ]
  return fields.some(field => field !== undefined && field.toLowerCase().includes(q))
}

function turnSections(
  turns: readonly RetryableTurn[],
  messages: readonly EditableMessageBlock[],
): TurnSection[] {
  return turns.map(retry => ({
    retry,
    messages: messages.filter(message => message.turn === retry.turn),
  }))
}

function VersionRow({
  version,
  disabled,
  onOpen,
  meta,
  onTogglePin,
}: {
  version: VersionSummary
  disabled: boolean
  onOpen: (sessionId: string) => void
  meta: VersionMeta
  onTogglePin: (sessionId: string, pinned: boolean) => void
}): ReactNode {
  const depthStyle = { '--message-edit-enhanced-depth': String(version.depth) } as CSSProperties
  const operation = version.operation === undefined
    ? version.parentSessionId === undefined ? 'Original' : 'External Branch'
    : OPERATION_LABEL[version.operation as Exclude<VersionOperation, undefined>]
  const hasDiff = version.before !== undefined || version.after !== undefined
  const [expanded, setExpanded] = useState(false)

  const diffChunks = hasDiff ? computeDiff(version.before || '', version.after || '') : []

  const handleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.version-expand')) return
    if ((e.target as HTMLElement).closest('.version-pin')) return
    onOpen(version.sessionId)
  }

  const handleExpandClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setExpanded(!expanded)
  }

  const handlePinClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onTogglePin(version.sessionId, !meta.pinned)
  }

  return (
    <li className={styles['versionItem']} style={depthStyle}>
      <button
        type="button"
        className={styles['versionButton']}
        data-current={version.current || undefined}
        disabled={version.current || disabled}
        onClick={handleClick}
      >
        <span className={styles['versionLine']} aria-hidden />
        <span className={styles['versionDot']} aria-hidden />
        <span className={styles['versionMain']}>
          <span className={styles['versionTitle']}>
            {operation}
            {version.targetTurn === undefined ? null : ` · Turn ${String(version.targetTurn)}`}
          </span>
          <span className={styles['versionMeta']}>
            {timeLabel(version.createdAt)} · {version.sessionId.slice(0, 12)}
          </span>
          {meta.tags.length > 0 && (
            <span className={styles['versionTags']}>
              {meta.tags.map((tag, idx) => (
                <span key={idx} className={styles['versionTag']}>#{tag}</span>
              ))}
            </span>
          )}
          {meta.note && <span className={styles['versionNote']}>{meta.note}</span>}
        </span>
        <button
          type="button"
          className={styles['versionPin']}
          onClick={handlePinClick}
          aria-label={meta.pinned ? 'Unpin version' : 'Pin version'}
          aria-pressed={meta.pinned}
          title={meta.pinned ? 'Unpin' : 'Pin'}
        >
          {meta.pinned ? '📌' : '📍'}
        </button>
        {version.current
          ? <span className={styles['currentBadge']}>Current</span>
          : version.onCurrentEffectPath
            ? <span className={styles['pathBadge']}>On Path</span>
            : null}
        {hasDiff && (
          <button
            type="button"
            className={styles['versionExpand']}
            onClick={handleExpandClick}
            aria-label={expanded ? 'Collapse diff' : 'Expand diff'}
            aria-expanded={expanded}
          >
            {expanded ? '▲' : '▼'}
          </button>
        )}
      </button>
      {expanded && hasDiff && (
        <div className={styles['versionDiffPanel']}>
          <div className={styles['versionDiffHeader']}>
            <span className={styles['diffLegend']}>
              <span className={styles['diffDelete']}>Removed</span>
              <span className={styles['diffInsert']}>Added</span>
              <span className={styles['diffEqual']}>Unchanged</span>
            </span>
          </div>
          <pre className={styles['versionDiffContent']}>
            {diffChunks.map((chunk, idx) => (
              <span key={idx} className={styles[`diff${chunk.type.charAt(0).toUpperCase() + chunk.type.slice(1)}`]}>
                {chunk.value}
              </span>
            ))}
          </pre>
        </div>
      )}
    </li>
  )
}

function MessageCard({
  message,
  editing,
  disabled,
  cascade,
  onBeginEdit,
  onCancelEdit,
  onTextChange,
  onApplyEdit,
  onDelete,
}: {
  message: EditableMessageBlock
  editing: EditingState | null
  disabled: boolean
  cascade: CascadePolicy
  onBeginEdit: (message: EditableMessageBlock) => void
  onCancelEdit: () => void
  onTextChange: (text: string) => void
  onApplyEdit: (message: EditableMessageBlock, text: string, cascade: CascadePolicy) => void
  onDelete?: (message: EditableMessageBlock) => void
}): ReactNode {
  const active = editing?.message.key === message.key
  return (
    <article className={styles['messageCard']}>
      <div className={styles['messageHeader']}>
        <span className={styles['kindBadge']} data-kind={message.kind}>{BLOCK_LABEL[message.kind]}</span>
        <span className={styles['messageTime']}>{timeLabel(message.time)}</span>
        <button
          type="button"
          className={styles['textButton']}
          disabled={disabled}
          onClick={() => { active ? onCancelEdit() : onBeginEdit(message) }}
        >
          {active ? 'Cancel' : 'Edit'}
        </button>
        {onDelete === null || message.kind !== 'user' ? null : (
          <button
            type="button"
            className={styles['textButton']}
            data-danger
            disabled={disabled}
            title="Delete this exchange and revert its workspace changes"
            onClick={() => { onDelete?.(message) }}
          >
            Delete
          </button>
        )}
      </div>
      {active && editing !== null
        ? (
          <div className={styles['editor']}>
            <textarea
              className={styles['textarea']}
              value={editing.text}
              rows={6}
              autoFocus
              onChange={(event) => { onTextChange(event.currentTarget.value) }}
            />
            <div className={styles['editorActions']}>
              <span className={styles['editorHint']}>Will branch from before this turn; the original version will remain.</span>
              <button
                type="button"
                className={styles['primaryButton']}
                disabled={disabled}
                onClick={() => { onApplyEdit(message, editing.text, cascade) }}
              >
                Apply & Regenerate
              </button>
            </div>
          </div>
        )
        : <pre className={styles['messageText']}>{message.text || '(empty)'}</pre>}
    </article>
  )
}

/** Conversation-view entry point. */
export function MessageEditTimelineView({
  useMessageEdit,
  acquire,
  load,
  edit,
  retry,
  reroll,
  previewDelete,
  deleteMessage,
  openVersion,
  exportBranch,
}: MessageEditTimelineViewProps): ReactNode {
  const state = useMessageEdit(value => value)
  const [cascade, setCascade] = useState<CascadePolicy>('truncate')
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [versionFilter, setVersionFilter] = useState<ActiveFilter>('all')
  const [versionSearch, setVersionSearch] = useState('')
  const [turnSearch, setTurnSearch] = useState('')
  const [versionMeta, setVersionMeta] = useState<StoredVersionMeta>(() => loadVersionMeta())
  const [exportFormat, setExportFormat] = useState<'json' | 'markdown'>('json')
  const [deleteTarget, setDeleteTarget] = useState<EditableMessageBlock | null>(null)
  const [deletePreviewData, setDeletePreviewData] = useState<MessageEditDeletePreview | null>(null)
  const [deletePreviewError, setDeletePreviewError] = useState<string | null>(null)
  const [deleteRollback, setDeleteRollback] = useState(true)
  const [deleteBusy, setDeleteBusy] = useState(false)

  /** Open the confirmation dialog and fetch the read-only impact report. */
  const requestDelete = (message: EditableMessageBlock): void => {
    setDeleteTarget(message)
    setDeletePreviewData(null)
    setDeletePreviewError(null)
    setDeleteRollback(true)
    previewDelete(message.eventSeq)
      .then((report) => {
        setDeletePreviewData(report)
        setDeleteRollback(report.checkpointFound)
      })
      .catch((error) => {
        setDeletePreviewError(error instanceof Error ? error.message : String(error))
      })
  }

  const confirmDelete = (): void => {
    if (deleteTarget === null || deleteBusy) return
    setDeleteBusy(true)
    const rollbackWorkspace = deleteRollback && (deletePreviewData?.checkpointFound ?? false)
    void deleteMessage(deleteTarget.eventSeq, rollbackWorkspace).finally(() => {
      setDeleteBusy(false)
      setDeleteTarget(null)
      setDeletePreviewData(null)
    })
  }

  useEffect(() => {
    saveVersionMeta(versionMeta)
  }, [versionMeta])

  useEffect(() => {
    const release = acquire()
    load()
    return release
  }, [acquire, load])

  const timeline = state.timeline
  const sections = useMemo(
    () => timeline === null ? [] : turnSections(timeline.retryableTurns, timeline.messages),
    [timeline],
  )
  const busy = state.pending !== null || state.status !== 'ready' || state.busy

  useEffect(() => {
    setEditing((current) => {
      if (current === null || timeline === null) return current
      return timeline.messages.some(message => message.key === current.message.key) ? current : null
    })
  }, [timeline])

  const filteredVersions = useMemo(() => {
    if (timeline === null) return []
    return timeline.versions.filter(version =>
      matchesFilter(version, versionFilter, versionMeta) && matchesSearch(version, versionSearch)
    )
  }, [timeline, versionFilter, versionSearch, versionMeta])

  const filteredSections = useMemo(() => {
    if (timeline === null) return []
    const q = turnSearch.toLowerCase()
    if (q.length === 0) return sections
    return sections
      .map(section => ({
        ...section,
        messages: section.messages.filter(m =>
          m.text.toLowerCase().includes(q) ||
          m.kind.toLowerCase().includes(q) ||
          String(m.turn).includes(q)
        ),
      }))
      .filter(section => section.messages.length > 0)
  }, [timeline, sections, turnSearch])

  /** Lightweight list virtualization bounds. */
  const VERSION_ROW_ESTIMATED_HEIGHT = 68
  const VIRTUAL_BUFFER = 8
  const versionListRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  useEffect(() => {
    const el = versionListRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    const onScroll = () => setScrollTop(el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [timeline])

  useEffect(() => {
    const el = versionListRef.current
    if (el) el.scrollTop = 0
    setScrollTop(0)
  }, [versionFilter, versionSearch])

  const virtualWindow = useMemo(() => {
    const total = filteredVersions.length
    const start = Math.max(0, Math.floor(scrollTop / VERSION_ROW_ESTIMATED_HEIGHT) - VIRTUAL_BUFFER)
    const visibleCount = Math.max(1, Math.ceil(viewportHeight / VERSION_ROW_ESTIMATED_HEIGHT))
    const end = Math.min(total, start + visibleCount + VIRTUAL_BUFFER * 2)
    return { total, start, end }
  }, [filteredVersions.length, scrollTop, viewportHeight])

  if (timeline === null && (state.status === 'idle' || state.status === 'loading')) {
    return <div className={styles['status']}>Loading message timeline…</div>
  }
  if (timeline === null && state.status === 'error') {
    return (
      <div className={styles['status']}>
        <p className={styles['error']}>{state.error}</p>
        <button type="button" className={styles['secondaryButton']} onClick={load}>Reload</button>
      </div>
    )
  }
  if (timeline === null) return null

  const applyEdit = (message: EditableMessageBlock, text: string, policy: CascadePolicy): void => {
    setEditing(null)
    void edit(message, text, policy)
  }

  const togglePin = (sessionId: string, pinned: boolean): void => {
    setVersionMeta(prev => updateVersionMeta(sessionId, { pinned }, prev))
  }

  return (
    <div className={styles['root']}>
      <header className={styles['pageHeader']}>
        <div>
          <h1 className={styles['title']}>Message Edit & Regeneration</h1>
          <p className={styles['intro']}>Each edit is recorded with its inverse; the entire turn and its tool chain are recomputed as a unit.</p>
        </div>
        <div className={styles['headerActions']}>
          <label className={styles['cascadeField']}>
            <span>Cascade Policy</span>
            <select
              className={styles['select']}
              value={cascade}
              disabled={busy}
              onChange={(event) => { setCascade(event.currentTarget.value as CascadePolicy) }}
            >
              <option value="truncate">Truncate following (default)</option>
              <option value="preserve">Preserve inputs & regenerate following</option>
            </select>
          </label>
          <button
            type="button"
            className={styles['primaryButton']}
            disabled={busy}
            onClick={() => { void reroll() }}
          >
            {state.pending === 'reroll' ? 'Regenerating…' : 'Regenerate Last Reply'}
          </button>
        </div>
      </header>

      {state.error === null ? null : <p className={styles['error']}>{state.error}</p>}
      {state.status === 'loading' ? <p className={styles['notice']}>Refreshing timeline…</p> : null}
      {state.switchingTo !== null ? (
        <p className={styles['notice']}>
          Switching session… <code>{state.switchingTo.slice(0, 12)}</code>
        </p>
      ) : null}
      {state.regenerating ? (
        <p className={styles['notice']} role="status">
          Regenerating response in the current session…
        </p>
      ) : null}

      <div className={styles['columns']}>
        <aside className={styles['versionsPanel']} aria-label="Version Timeline">
          <div className={styles['sectionHeading']}>
            <h2 className={styles['subtitle']}>Version Timeline</h2>
            <span className={styles['count']}>{String(filteredVersions.length)} / {String(timeline.versions.length)}</span>
            <select
              className={styles['select']}
              value={exportFormat}
              disabled={busy || timeline === null}
              onChange={(event) => { setExportFormat(event.currentTarget.value as 'json' | 'markdown') }}
            >
              <option value="json">JSON</option>
              <option value="markdown">Markdown</option>
            </select>
            <button
              type="button"
              className={styles['secondaryButton']}
              disabled={busy || timeline === null}
              onClick={() => { void exportBranch(exportFormat) }}
              title={`Export current timeline as ${exportFormat.toUpperCase()}`}
            >
              Export
            </button>
          </div>

          <div className={styles['filterBar']}>
            <input
              type="search"
              className={styles['filterSearch']}
              placeholder="Search versions…"
              value={versionSearch}
              onChange={(event) => { setVersionSearch(event.currentTarget.value) }}
            />
            <div className={styles['filterChips']}>
              {(Object.keys(FILTER_LABEL) as ActiveFilter[]).map(filter => (
                <button
                  key={filter}
                  type="button"
                  className={styles['filterChip']}
                  data-active={versionFilter === filter || undefined}
                  disabled={busy}
                  onClick={() => { setVersionFilter(filter) }}
                >
                  {FILTER_LABEL[filter]}
                </button>
              ))}
            </div>
          </div>

          <div className={styles['effectControls']}>
            <span className={styles['effectDepth']}>Effect chain: {String(timeline.undoStack.length)} level(s)</span>
            <div className={styles['effectButtons']}>
              <button
                type="button"
                className={styles['secondaryButton']}
                disabled={busy || timeline.undoStack[0] === undefined}
                onClick={() => {
                  const target = timeline.undoStack[0]
                  if (target !== undefined) void openVersion(target)
                }}
              >
                Undo Current Effect
              </button>
              <button
                type="button"
                className={styles['secondaryButton']}
                disabled={busy || timeline.redoSessionIds.length === 0}
                onClick={() => {
                  const target = timeline.redoSessionIds.at(-1)
                  if (target !== undefined) void openVersion(target)
                }}
              >
                {timeline.redoSessionIds.length > 1
                  ? `Redo Latest Branch (${String(timeline.redoSessionIds.length)})`
                  : 'Redo Next Effect'}
              </button>
            </div>
          </div>
          <div className={styles['versionListScroller']} ref={versionListRef}>
            {filteredVersions.length === 0
              ? <li className={styles['empty']}>No versions match the current filter.</li>
              : (
                <ol className={styles['versionList']} style={{
                  height: `${virtualWindow.total * VERSION_ROW_ESTIMATED_HEIGHT}px`,
                  position: 'relative',
                } as CSSProperties}>
                  {filteredVersions.slice(virtualWindow.start, virtualWindow.end).map((version, index) => (
                    <li
                      key={version.sessionId}
                      className={styles['versionItem']}
                      style={{
                        position: 'absolute',
                        top: `${(virtualWindow.start + index) * VERSION_ROW_ESTIMATED_HEIGHT}px`,
                        left: 0,
                        right: 0,
                      } as CSSProperties}
                    >
                      <VersionRow
                        version={version}
                        disabled={busy}
                        onOpen={(sessionId) => { void openVersion(sessionId) }}
                        meta={getVersionMeta(version.sessionId, versionMeta)}
                        onTogglePin={togglePin}
                      />
                    </li>
                  ))}
                </ol>
              )}
          </div>
        </aside>

        <main className={styles['turnsPanel']}>
          <div className={styles['sectionHeading']}>
            <h2 className={styles['subtitle']}>Settled Messages</h2>
            <span className={styles['count']}>{String(filteredSections.reduce((sum, s) => sum + s.messages.length, 0))} / {String(timeline.messages.length)}</span>
          </div>

          <div className={styles['turnFilterBar']}>
            <input
              type="search"
              className={styles['filterSearch']}
              placeholder="Search messages…"
              value={turnSearch}
              onChange={(event) => { setTurnSearch(event.currentTarget.value) }}
            />
          </div>

          {filteredSections.length === 0 && state.optimisticEdit === null
            ? <p className={styles['empty']}>No settled turns available to edit in this session.</p>
            : (
              <ol className={styles['turnList']}>
                {filteredSections.map(section => (
                  <li key={section.retry.turn} className={styles['turnSection']}>
                    <div className={styles['turnHeader']}>
                      <div>
                        <h3 className={styles['turnTitle']}>Turn {String(section.retry.turn)}</h3>
                        <p className={styles['turnPreview']}>{section.retry.preview || '(empty user input)'}</p>
                      </div>
                      <button
                        type="button"
                        className={styles['secondaryButton']}
                        disabled={busy}
                        onClick={() => { void retry(section.retry.turn, cascade) }}
                      >
                        {state.pending === 'retry' ? 'Retrying…' : 'Retry This Turn'}
                      </button>
                    </div>
                    <div className={styles['messageList']}>
                      {section.messages.map(message => (
                        <MessageCard
                          key={message.key}
                          message={message}
                          editing={editing}
                          disabled={busy}
                          cascade={cascade}
                          onBeginEdit={value => { setEditing({ message: value, text: value.text }) }}
                          onCancelEdit={() => { setEditing(null) }}
                          onTextChange={(text) => {
                            setEditing(current => current === null ? null : { ...current, text })
                          }}
                          onApplyEdit={applyEdit}
                          onDelete={requestDelete}
                        />
                      ))}
                    </div>
                  </li>
                ))}
                {state.optimisticEdit === null ? null : (
                  <li className={styles['turnSection']} data-optimistic="true">
                    <div className={styles['turnHeader']}>
                      <div>
                        <h3 className={styles['turnTitle']}>Turn {String(state.optimisticEdit.turn)}</h3>
                        <p className={styles['turnPreview']}>Regenerating in the current session…</p>
                      </div>
                    </div>
                    <div className={styles['messageList']}>
                      <div className={styles['optimisticMessage']}>
                        <span className={styles['optimisticKind']}>User</span>
                        <span className={styles['optimisticText']}>{state.optimisticEdit.text || '(empty)'}</span>
                        <span className={styles['optimisticPulse']} role="status">regenerating</span>
                      </div>
                    </div>
                  </li>
                )}
              </ol>
            )}
        </main>
      </div>

      {deleteTarget === null ? null : (
        <div className={styles['dialogOverlay']} role="presentation" onClick={() => { if (!deleteBusy) setDeleteTarget(null) }}>
          <div
            className={styles['dialog']}
            role="dialog"
            aria-modal="true"
            aria-label="Delete message"
            onClick={(event) => { event.stopPropagation() }}
          >
            <h3 className={styles['dialogTitle']}>Delete this message?</h3>
            <p className={styles['dialogText']}>
              This will delete the user message, its response, and revert any code changes caused by this exchange.
            </p>
            <pre className={styles['dialogQuote']}>{deleteTarget.text || '(empty)'}</pre>

            {deletePreviewData === null && deletePreviewError === null ? (
              <p className={styles['dialogText']}>Checking impact…</p>
            ) : null}
            {deletePreviewError !== null ? (
              <p className={styles['dialogWarning']}>Impact check failed: {deletePreviewError}</p>
            ) : null}

            {deletePreviewData !== null ? (
              <>
                <ul className={styles['dialogFacts']}>
                  <li>
                    Removes turn {String(deletePreviewData.turn)}
                    {deletePreviewData.laterTurns.length > 0
                      ? ` and ${String(deletePreviewData.laterTurns.length)} later exchange(s) (turn ${deletePreviewData.laterTurns.map(t => String(t)).join(', ')})`
                      : ''}
                    .
                  </li>
                  <li>
                    {deletePreviewData.willBranch
                      ? 'This session is not live, so the deletion will create a branch without these exchanges.'
                      : 'The exchanges are removed from this conversation in place.'}
                    {' '}The full history stays in the session log as an audit trail.
                  </li>
                  {deletePreviewData.checkpointFound
                    ? (
                      <li>
                        Workspace snapshot found ({deletePreviewData.workspacePath}):{' '}
                        {String(deletePreviewData.filesToRevert.length)} file(s) to revert,{' '}
                        {String(deletePreviewData.filesToRemove.length)} created-after file(s) to remove.
                      </li>
                    )
                    : (
                      <li>
                        No workspace snapshot for this message
                        {deletePreviewData.checkpointReason === undefined ? '' : `: ${deletePreviewData.checkpointReason}`}.
                        Code changes cannot be reverted automatically.
                      </li>
                    )}
                </ul>
                {(deletePreviewData.filesToRevert.length > 0 || deletePreviewData.filesToRemove.length > 0) && deleteRollback
                  ? (
                    <div className={styles['fileList']}>
                      {[...deletePreviewData.filesToRevert, ...deletePreviewData.filesToRemove].slice(0, 8).map(file => (
                        <div key={`${file.change}:${file.path}`} className={styles['fileRow']}>
                          <span className={styles['fileChange']} data-change={file.change}>
                            {file.change === 'revert' ? 'revert' : 'remove'}
                          </span>
                          <code className={styles['filePath']}>{file.path}</code>
                        </div>
                      ))}
                      {deletePreviewData.filesToRevert.length + deletePreviewData.filesToRemove.length > 8
                        ? (
                          <div className={styles['fileRow']}>
                            …and {String(deletePreviewData.filesToRevert.length + deletePreviewData.filesToRemove.length - 8)} more
                          </div>
                        )
                        : null}
                    </div>
                  )
                  : null}
                {deletePreviewData.skipped.length > 0
                  ? (
                    <p className={styles['dialogText']}>
                      {String(deletePreviewData.skipped.length)} binary/oversized file(s) are left untouched.
                    </p>
                  )
                  : null}
                {deletePreviewData.checkpointFound
                  ? (
                    <label className={styles['dialogCheck']}>
                      <input
                        type="checkbox"
                        checked={deleteRollback}
                        disabled={deleteBusy}
                        onChange={(event) => { setDeleteRollback(event.currentTarget.checked) }}
                      />
                      Also revert workspace changes from this exchange
                    </label>
                  )
                  : null}
                {deletePreviewData.warnings.map((warning, index) => (
                  <p key={index} className={styles['dialogWarning']}>{warning}</p>
                ))}
              </>
            ) : null}

            <div className={styles['dialogActions']}>
              <button
                type="button"
                className={styles['secondaryButton']}
                disabled={deleteBusy}
                onClick={() => { setDeleteTarget(null) }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles['dangerButton']}
                disabled={deleteBusy || (deleteRollback && deletePreviewError !== null)}
                onClick={() => { confirmDelete() }}
              >
                {deleteBusy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}