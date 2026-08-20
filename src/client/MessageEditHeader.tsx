import { useEffect, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageEditFace } from './controller.ts'
import { InlineMessageEdit } from './InlineMessageEdit.tsx'
import styles from './MessageEditHeader.module.css'

type MessageEditHeaderProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<MessageEditFace>

/** Header contribution shared with the Timeline controller. */
export function MessageEditHeader({
 useMessageEdit,
 acquire,
 load,
 openVersion,
 reroll,
 edit,
 retry,
}: MessageEditHeaderProps): ReactNode {
 const state = useMessageEdit(value => value)

 useEffect(() => {
  const release = acquire()
  load()
  return release
 }, [acquire, load])

 const timeline = state.timeline
 const versions = state.timeline?.versions ?? []
 const undoSessionId = timeline?.undoStack[0]
 const redoSessionId = timeline?.redoSessionIds.at(-1)
 const effectDepth = timeline?.undoStack.length ?? 0
 const busy = state.pending !== null || state.status !== 'ready'

 return (
  <>
   <InlineMessageEdit
    messages={state.status === 'ready' && state.pending === null ? timeline?.messages ?? [] : []}
    edit={edit}
    retry={retry}
   />
   <div className={styles['root']}>
    <button
     type="button"
     className={styles['iconButton']}
     aria-label="Undo current version effect"
     title="Undo current effect, keep earlier effects"
     disabled={undoSessionId === undefined || busy}
     onClick={() => { if (undoSessionId !== undefined) void openVersion(undoSessionId) }}
    >
     ←
    </button>
    <span className={styles['counter']}>
     {versions.length === 0 ? 'Effects —' : `Effects: ${String(effectDepth)} deep · ${String(versions.length)} versions`}
    </span>
    <button
     type="button"
     className={styles['iconButton']}
     aria-label="Redo next version effect"
     title={timeline !== null && timeline.redoSessionIds.length > 1
      ? `Redo latest effect (${String(timeline.redoSessionIds.length - 1)} other branch(es))`
      : 'Redo next effect'}
     disabled={redoSessionId === undefined || busy}
     onClick={() => { if (redoSessionId !== undefined) void openVersion(redoSessionId) }}
    >
     →
    </button>
    <button
     type="button"
     className={styles['rerollButton']}
     disabled={busy || state.timeline === null}
     onClick={() => { void reroll() }}
    >
     {state.pending === 'reroll' ? 'Regenerating…' : 'Regenerate'}
    </button>
   </div>
  </>
 )
}
