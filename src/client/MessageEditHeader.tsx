import { useEffect, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageEditFace } from './controller.ts'
import { DeleteConfirmDialog } from './DeleteConfirmDialog.tsx'
import { InlineMessageEdit } from './InlineMessageEdit.tsx'
import styles from './MessageEditHeader.module.css'

type MessageEditHeaderProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<MessageEditFace>

/** Header contribution shared with the Timeline controller. The header is
 * mounted across every conversation view tab, so it also hosts the delete
 * confirmation dialog opened from the chat turn-tail control. */
export function MessageEditHeader({
 useMessageEdit,
 acquire,
 load,
 openVersion,
 reroll,
 edit,
 retry,
 deleteMessage,
 closeDelete,
 setDeleteRollback,
}: MessageEditHeaderProps): ReactNode {
 const state = useMessageEdit(value => value)

 useEffect(() => {
  const release = acquire()
  load()
  return release
 }, [acquire, load])

 const dialog = state.deleteDialog
 const dialogBusy = state.pending === 'delete'

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
   {dialog === null ? null : (
    <DeleteConfirmDialog
      targetText={(() => {
       if (state.timeline !== null) {
        const message = state.timeline.messages.find(candidate => candidate.eventSeq === dialog.eventSeq && candidate.kind === 'user')
        if (message !== undefined) return message.text
       }
       return ''
      })()}
      preview={dialog.preview}
      error={dialog.error ?? state.error}
      busy={dialogBusy}
      rollback={dialog.rollback}
      onRollbackChange={setDeleteRollback}
      onCancel={() => { closeDelete() }}
      onConfirm={() => {
       const rollbackWorkspace = dialog.rollback && (dialog.preview?.checkpointFound ?? false)
       void deleteMessage(dialog.eventSeq, rollbackWorkspace).then((ok) => {
        if (ok) closeDelete()
       })
      }}
    />
   )}
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
