/** Shared delete-confirmation dialog: rendered from the Timeline view and
 * from the always-mounted session header (chat turn-tail flow). */
import type { ReactNode } from 'react'
import type { MessageEditDeletePreview } from '../shared.ts'
import styles from './MessageEditTimelineView.module.css'

export interface DeleteConfirmDialogProps {
  /** Edited user text of the exchange being deleted. */
  targetText: string
  preview: MessageEditDeletePreview | null
  /** Impact-check failure, shown instead of the report. */
  error: string | null
  busy: boolean
  rollback: boolean
  onRollbackChange: (next: boolean) => void
  onConfirm: () => void
  onCancel: () => void
}

export function DeleteConfirmDialog({
  targetText,
  preview,
  error,
  busy,
  rollback,
  onRollbackChange,
  onConfirm,
  onCancel,
}: DeleteConfirmDialogProps): ReactNode {
  return (
    <div className={styles['dialogOverlay']} role="presentation" onClick={() => { if (!busy) onCancel() }}>
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
        <pre className={styles['dialogQuote']}>{targetText || '(empty)'}</pre>

        {preview === null && error === null ? (
          <p className={styles['dialogText']}>Checking impact…</p>
        ) : null}
        {error !== null ? (
          <p className={styles['dialogWarning']}>Impact check failed: {error}</p>
        ) : null}

        {preview !== null ? (
          <>
            <ul className={styles['dialogFacts']}>
              <li>
                Removes turn {String(preview.turn)}
                {preview.laterTurns.length > 0
                  ? ` and ${String(preview.laterTurns.length)} later exchange(s) (turn ${preview.laterTurns.map(t => String(t)).join(', ')})`
                  : ''}
                .
              </li>
              <li>
                {preview.willBranch
                  ? 'This session is not live, so the deletion will create a branch without these exchanges.'
                  : 'The exchanges are removed from this conversation in place.'}
                {' '}The full history stays in the session log as an audit trail.
              </li>
              {preview.checkpointFound
                ? (
                  <li>
                    Workspace snapshot found ({preview.workspacePath}):{' '}
                    {String(preview.filesToRevert.length)} file(s) to revert,{' '}
                    {String(preview.filesToRemove.length)} created-after file(s) to remove.
                  </li>
                )
                : (
                  <li>
                    No workspace snapshot for this message
                    {preview.checkpointReason === undefined ? '' : `: ${preview.checkpointReason}`}.
                    Code changes cannot be reverted automatically.
                  </li>
                )}
            </ul>
            {(preview.filesToRevert.length > 0 || preview.filesToRemove.length > 0) && rollback
              ? (
                <div className={styles['fileList']}>
                  {[...preview.filesToRevert, ...preview.filesToRemove].slice(0, 8).map(file => (
                    <div key={`${file.change}:${file.path}`} className={styles['fileRow']}>
                      <span className={styles['fileChange']} data-change={file.change}>
                        {file.change === 'revert' ? 'revert' : 'remove'}
                      </span>
                      <code className={styles['filePath']}>{file.path}</code>
                    </div>
                  ))}
                  {preview.filesToRevert.length + preview.filesToRemove.length > 8
                    ? (
                      <div className={styles['fileRow']}>
                        …and {String(preview.filesToRevert.length + preview.filesToRemove.length - 8)} more
                      </div>
                    )
                    : null}
                </div>
              )
              : null}
            {preview.skipped.length > 0
              ? (
                <p className={styles['dialogText']}>
                  {String(preview.skipped.length)} binary/oversized file(s) are left untouched.
                </p>
              )
              : null}
            {preview.checkpointFound
              ? (
                <label className={styles['dialogCheck']}>
                  <input
                    type="checkbox"
                    checked={rollback}
                    disabled={busy}
                    onChange={(event) => { onRollbackChange(event.currentTarget.checked) }}
                  />
                  Also revert workspace changes from this exchange
                </label>
              )
              : null}
            {preview.warnings.map((warning, index) => (
              <p key={index} className={styles['dialogWarning']}>{warning}</p>
            ))}
          </>
        ) : null}

        <div className={styles['dialogActions']}>
          <button
            type="button"
            className={styles['secondaryButton']}
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles['dangerButton']}
            disabled={busy || (rollback && error !== null)}
            onClick={onConfirm}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
