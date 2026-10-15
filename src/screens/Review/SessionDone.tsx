import { RotateCcw } from 'lucide-react'
import { useEffect } from 'react'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Session } from '../../core/contracts/workspace'
import { summarize } from '../../core/model/sessions'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import styles from './Review.module.css'

/**
 * The end of a custom session: it is closed in the log, and its results stay on screen (no settling into "All
 * caught up": a session is about its own cards, not today's queue), with the missed cards one tap away.
 */
export function SessionDone({
  session,
  onLeave,
  onRelaunch,
}: {
  session: Session
  onLeave: () => void
  onRelaunch: () => void
}) {
  const t = useT()
  const ws = useWorkspace()
  const result = useWorkspaceData(['reviews', 'sessions'], (w) =>
    summarize(w.sessions.get(session.id) ?? session, w.reviews.forSession(session.id)),
  )
  // Ending again does nothing: an undo and a second finish keep the first end.
  useEffect(() => ws.sessions.end(session.id), [ws, session.id])
  const missed = result.failed.length

  return (
    <div className={styles.main}>
      <section className={styles.stage} aria-live="polite">
        <div className={styles.summary} data-testid="session-done">
          <h2 className={styles.summaryTitle}>{t('review.sessionComplete')}</h2>
          <p className={styles.summaryBody}>{t('review.reviewed', { count: result.cards })}</p>
          <p className={styles.summaryBody}>
            {missed > 0 ? t('review.sessionMissed', { count: missed }) : t('review.sessionNoneMissed')}
          </p>
        </div>
        {missed > 0 && (
          <Button variant="primary" icon={<RotateCcw size={18} aria-hidden="true" />} onClick={onRelaunch}>
            {t('review.relaunchMissed')}
          </Button>
        )}
        <Button variant={missed > 0 ? 'secondary' : 'primary'} onClick={onLeave}>
          {t('common.done')}
        </Button>
      </section>
    </div>
  )
}
