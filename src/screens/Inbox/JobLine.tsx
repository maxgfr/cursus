import type { AiJob } from '../../core/ai/jobs'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import styles from './Inbox.module.css'

/** Finished jobs worth a word stay this long (a failure stays until it is tried again). */
const RECENT_MS = 24 * 3600_000

/** Whether a job says something to the student about its source. */
export function jobWorthShowing(job: AiJob, hasDrafts: boolean, now: number): boolean {
  switch (job.status) {
    case 'cancelled':
      // Stopped half-way by the student: it can be resumed for a while. Never asked for: nothing to say.
      return (
        job.reason === 'manual' && job.progress.done.length < job.progress.total && now - job.updatedAt <= RECENT_MS
      )
    case 'failed':
      return job.reason === 'manual'
    case 'done':
      if (now - job.updatedAt > RECENT_MS) return false
      if (job.outcome === 'empty') return true
      return job.outcome === 'proposed' && job.proposed === 0 && !hasDrafts
    default:
      return true
  }
}

export interface JobActions {
  /** Stops a job (what it wrote stays). */
  cancel(id: string): void
  /** Runs a stopped or failed job again, from where it stopped. */
  retry(id: string): void
}

/**
 * Where the cards asked for on a source stand: waiting their turn, being read (with Stop), waiting for a
 * connection or a model, stopped (to resume), failed (to try again). `actions` is absent where the queue cannot be
 * acted on from (it then only says).
 */
export function JobLine({ job, actions }: { job: AiJob; actions?: JobActions }) {
  const t = useT()
  const stop = actions && (
    <Button variant="plain" onClick={() => actions.cancel(job.id)}>
      {t('ai.inboxCancel')}
    </Button>
  )
  let text: string
  let buttons = null
  let tone: 'quiet' | 'error' = 'quiet'
  switch (job.status) {
    case 'queued':
      text = t('ai.inboxQueued')
      buttons = stop
      break
    case 'running':
      text =
        job.progress.total > 0
          ? t('ai.inboxRunningProgress', { done: job.progress.done.length, total: job.progress.total })
          : t('ai.inboxRunning')
      buttons = stop
      break
    case 'waiting':
      text = t('ai.inboxWaiting')
      buttons = stop
      break
    case 'needs-model':
      text = t('ai.inboxNeedsModelLine')
      buttons = stop
      break
    case 'failed':
      tone = 'error'
      text = t('ai.inboxFailed', { reason: job.error ?? '' })
      buttons = actions && (
        <Button variant="secondary" onClick={() => actions.retry(job.id)}>
          {t('ai.inboxRetry')}
        </Button>
      )
      break
    case 'cancelled':
      text =
        job.progress.total > 0
          ? t('ai.inboxStopped', { done: job.progress.done.length, total: job.progress.total })
          : t('ai.inboxCancelled')
      buttons = actions && (
        <Button variant="secondary" onClick={() => actions.retry(job.id)}>
          {t('ai.inboxResume')}
        </Button>
      )
      break
    case 'done':
      text = job.outcome === 'empty' ? t('ai.inboxEmptySource') : t('ai.inboxNoNew')
      break
  }
  return (
    <div className={styles.job} data-testid="job-line" data-status={job.status}>
      <p className={tone === 'error' ? styles.jobError : styles.jobText} aria-live="polite">
        {text}
      </p>
      {buttons && <div className={styles.jobActions}>{buttons}</div>}
    </div>
  )
}
