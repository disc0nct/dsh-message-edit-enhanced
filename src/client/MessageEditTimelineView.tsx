/** Timeline tab: durable version tree plus turn/block edit and retry controls. */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {
 CascadePolicy,
 EditableBlockKind,
 EditableMessageBlock,
 RetryableTurn,
 VersionOperation,
 VersionSummary,
} from '../shared.ts'
import type { MessageEditFace } from './controller.ts'
import styles from './MessageEditTimelineView.module.css'

type MessageEditTimelineViewProps = ConvViewProps & InjectFace<MessageEditFace>

interface TurnSection {
 retry: RetryableTurn
 messages: EditableMessageBlock[]
}

interface EditingState {
 message: EditableMessageBlock
 text: string
}

const BLOCK_LABEL: Record<EditableBlockKind, string> = {
 user: 'User Message',
 'assistant.reasoning': 'Assistant Reasoning',
 'assistant.response': 'Assistant Response',
}

const OPERATION_LABEL: Record<VersionOperation, string> = {
 edit: 'Edit',
 reroll: 'Reroll',
 retry: 'Retry',
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

function turnSections(
 turns: readonly RetryableTurn[],
 messages: readonly EditableMessageBlock[],
): TurnSection[] {
 return turns.map(retry => ({
  retry,
  messages: messages.filter(message => message.turn === retry.turn),
 }))
}

function VersionRow({ version, disabled, onOpen }: {
  version: VersionSummary
  disabled: boolean
  onOpen: (sessionId: string) => void
}): ReactNode {
  const depthStyle = { '--message-edit-enhanced-depth': String(version.depth) } as CSSProperties
 const operation = version.operation === undefined
  ? version.parentSessionId === undefined ? 'Original' : 'External Branch'
  : OPERATION_LABEL[version.operation]
 return (
  <li className={styles['versionItem']} style={depthStyle}>
   <button
    type="button"
    className={styles['versionButton']}
    data-current={version.current || undefined}
    disabled={version.current || disabled}
    onClick={() => { onOpen(version.sessionId) }}
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
     {version.before === undefined && version.after === undefined
      ? null
      : (
       <span className={styles['versionDiff']}>
        <span>Before: {version.before || '(empty)'}</span>
        <span>After: {version.after || '(empty)'}</span>
       </span>
      )}
    </span>
    {version.current
     ? <span className={styles['currentBadge']}>Current</span>
     : version.onCurrentEffectPath
      ? <span className={styles['pathBadge']}>On Path</span>
      : null}
   </button>
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
}: {
 message: EditableMessageBlock
 editing: EditingState | null
 disabled: boolean
 cascade: CascadePolicy
 onBeginEdit: (message: EditableMessageBlock) => void
 onCancelEdit: () => void
 onTextChange: (text: string) => void
 onApplyEdit: (message: EditableMessageBlock, text: string, cascade: CascadePolicy) => void
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
 openVersion,
}: MessageEditTimelineViewProps): ReactNode {
 const state = useMessageEdit(value => value)
 const [cascade, setCascade] = useState<CascadePolicy>('truncate')
 const [editing, setEditing] = useState<EditingState | null>(null)

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
 const busy = state.pending !== null || state.status !== 'ready'

 useEffect(() => {
  setEditing((current) => {
   if (current === null || timeline === null) return current
   return timeline.messages.some(message => message.key === current.message.key) ? current : null
  })
 }, [timeline])

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

   <div className={styles['columns']}>
    <aside className={styles['versionsPanel']} aria-label="Version Timeline">
     <div className={styles['sectionHeading']}>
      <h2 className={styles['subtitle']}>Version Timeline</h2>
      <span className={styles['count']}>{String(timeline.versions.length)}</span>
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
     <ol className={styles['versionList']}>
      {timeline.versions.map(version => (
       <VersionRow
        key={version.sessionId}
        version={version}
        disabled={busy}
        onOpen={(sessionId) => { void openVersion(sessionId) }}
       />
      ))}
     </ol>
    </aside>

    <main className={styles['turnsPanel']}>
     <div className={styles['sectionHeading']}>
      <h2 className={styles['subtitle']}>Settled Messages</h2>
      <span className={styles['count']}>{String(timeline.messages.length)}</span>
     </div>
     {sections.length === 0
      ? <p className={styles['empty']}>No settled turns available to edit in this session.</p>
      : (
       <ol className={styles['turnList']}>
        {sections.map(section => (
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
            />
           ))}
          </div>
         </li>
        ))}
       </ol>
      )}
    </main>
   </div>
  </div>
 )
}
