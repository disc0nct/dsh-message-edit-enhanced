/** Chat-view delete affordance: one Delete control on every completed turn
 * tail (before the turn's IconActions), opening the shared confirmation
 * dialog through the per-session controller. Renders nothing for turns
 * without a settled user message. */
import type { ReactNode } from 'react'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageEditFace } from './controller.ts'
import styles from './ChatTurnDelete.module.css'

type ChatTurnDeleteProps = { matched: TurnTailOwnerProps } & InjectFace<MessageEditFace>

export function ChatTurnDelete({
  matched,
  useMessageEdit,
  openDelete,
}: ChatTurnDeleteProps): ReactNode {
  const state = useMessageEdit(value => value)
  const retryable = state.timeline?.retryableTurns.find(turn => turn.turn === matched.turn.turn)
  if (retryable === undefined) return null
  const busy = state.pending !== null || state.status !== 'ready' || state.busy || state.regenerating
  return (
    <button
      type="button"
      className={styles['deleteButton']}
      disabled={busy}
      title="Delete this exchange and revert its workspace changes"
      onClick={() => { openDelete(retryable.userEventSeq) }}
    >
      Delete
    </button>
  )
}
