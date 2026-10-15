import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import type { AiJob } from '../../core/ai/jobs'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import styles from './Inbox.module.css'

/** Finished jobs worth a word stay this long (a failure stays until it is tried again). */
const RECENT_MS = 24 * 3600_000

/** Whether a job says something to the student about its source. */
export function jobWorthShowing(job: AiJob, hasDrafts: boolean, now: number): boolean {
  switch (job.status) {
    case 'cancelled':
      return false
    case 'failed':
      return true
    case 'done':
      // Spending past a cap is always said (like a failure), however long ago.
      if (job.overspent) return true
      if (now - job.updatedAt > RECENT_MS) return false
      if (job.outcome === 'added') return job.added > 0
      if (job.outcome === 'empty') return true
      return job.outcome === 'proposed' && job.proposed === 0 && !hasDrafts
    default:
      return true
  }
}

export interface JobActions {
  cancel(id: string): void
  retry(id: string): void
  approve(id: string): void
}

/**
 * Where a source's questions stand: waiting its turn, being read, waiting for a connection or a model, over a
 * cost cap (with the estimate, to allow it once), failed (to try again). `actions` is absent where the queue
 * cannot be acted on from (it then only says).
 */
export function JobLine({ job, actions }: { job: AiJob; actions?: JobActions }) {
  const t = useT()
  const locale = useLocale()
  const usd = (n: number) => formatUsd(locale, n)
  const cancel = actions && (
    <Button variant="plain" onClick={() => actions.cancel(job.id)}>
      {t('ai.inboxCancel')}
    </Button>
  )
  let text: string
  let buttons = null
  let tone: 'quiet' | 'warn' | 'error' = 'quiet'
  switch (job.status) {
    case 'queued':
      text = t('ai.inboxQueued')
      buttons = cancel
      break
    case 'running':
      text =
        job.progress.total > 0
          ? t('ai.inboxRunningProgress', { done: job.progress.done.length, total: job.progress.total })
          : t('ai.inboxRunning')
      buttons = cancel
      break
    case 'waiting':
      text = t('ai.inboxWaiting')
      buttons = cancel
      break
    case 'needs-model':
      text = t('ai.inboxNeedsModelLine')
      buttons = cancel
      break
    case 'over-cap': {
      tone = 'warn'
      const cost = usd(job.estimate?.cost ?? 0)
      const cap = job.cap
      text =
        cap?.scope === 'month'
          ? t('ai.inboxOverMonth', { cost, spent: usd(cap.spent), limit: usd(cap.limit) })
          : t('ai.inboxOverDocument', { cost, limit: usd(cap?.limit ?? 0) })
      buttons = actions && (
        <>
          <Button variant="primary" onClick={() => actions.approve(job.id)}>
            {t('ai.inboxAllow', { cost })}
          </Button>
          <Link href={paths.settingsAi} className={styles.link}>
            {t('ai.inboxLimits')}
          </Link>
          {cancel}
        </>
      )
      break
    }
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
      text = t('ai.inboxCancelled')
      break
    case 'done': {
      const over = job.overspent
      if (over) {
        // The last call passed a cap: nothing was left to stop, so the job finished, and says what it cost.
        tone = 'warn'
        const values = { spent: usd(over.spent), limit: usd(over.limit) }
        text = over.scope === 'month' ? t('ai.inboxOverspentMonth', values) : t('ai.inboxOverspentDocument', values)
        buttons = actions && (
          <Link href={paths.settingsAi} className={styles.link}>
            {t('ai.inboxLimits')}
          </Link>
        )
        break
      }
      text =
        job.outcome === 'added'
          ? t('ai.inboxAdded', { count: job.added })
          : job.outcome === 'empty'
            ? t('ai.inboxEmptySource')
            : t('ai.inboxNoNew')
      break
    }
  }
  return (
    <div className={styles.job} data-testid="job-line" data-status={job.status}>
      <p
        className={tone === 'error' ? styles.jobError : tone === 'warn' ? styles.jobWarn : styles.jobText}
        aria-live="polite"
      >
        {text}
      </p>
      {buttons && <div className={styles.jobActions}>{buttons}</div>}
    </div>
  )
}
