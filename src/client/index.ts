/** Message Edit browser half: Timeline view, header controls, and the chat
 * turn-tail delete affordance. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { MESSAGE_EDIT_VIEW_ORDER } from '../shared.ts'
import { ChatTurnDelete } from './ChatTurnDelete.tsx'
import type { MessageEditFace } from './controller.ts'
import { MessageEditController } from './controller.ts'
import { MessageEditHeader } from './MessageEditHeader.tsx'
import { MessageEditTimelineView } from './MessageEditTimelineView.tsx'

/** Explicit value sources and slot declaration-order edges. */
export const inject = ['slots', 'conversation', 'connection', 'sessions']

/** Register both UI contributions over one per-session controller identity. */
export function apply(ctx: ClientContext): void {
 const controllers = new Map<SessionId, MessageEditController>()
 const controllerFor = (sessionId: SessionId): MessageEditController => {
  let controller = controllers.get(sessionId)
  if (controller === undefined) {
   controller = new MessageEditController(ctx, sessionId)
   controllers.set(sessionId, controller)
  }
  return controller
 }

 ctx.on('connection/reset', () => {
  for (const controller of controllers.values()) controller.refreshIfLoaded()
 })

  ctx.slots.register({
    name: 'conversation.view',
    id: 'message-edit-enhanced-timeline',
    order: MESSAGE_EDIT_VIEW_ORDER,
    label: 'Timeline',
    inject: (sessionId: SessionId) => controllerFor(sessionId).face,
  }, MessageEditTimelineView)

  ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'message-edit-enhanced-controls',
    order: MESSAGE_EDIT_VIEW_ORDER,
    inject: (sessionId: SessionId) => controllerFor(sessionId).face,
  }, MessageEditHeader)

  // Chain entries carry no typed inject seat in the SlotMap contract, but the
  // runtime records and honors one - shipped precedent:
  // dsh-client-ui-deliverables registers ProducedFiles on this very slot with
  // an inject face. Type the call site precisely instead of casting blind.
  ;(ctx.slots.register as unknown as (
    options: {
      name: 'conversation.chat.turnTail'
      select: (owner: TurnTailOwnerProps) => TurnTailOwnerProps
      inject: (sessionId: SessionId) => MessageEditFace
    },
    component: (props: { matched: TurnTailOwnerProps } & InjectFace<MessageEditFace>) => ReturnType<typeof ChatTurnDelete>,
  ) => () => void)({
    name: 'conversation.chat.turnTail',
    select: (owner) => owner,
    inject: (sessionId) => controllerFor(sessionId).face,
  }, ChatTurnDelete)
}
