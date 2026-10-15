import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id } from '../../core/contracts/workspace'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { isActiveJob, jobOf, liveQueue, proposeFor, useAutoJobs } from '../../ui/data/autoQuestions.ts'
import inbox from '../Inbox/Inbox.module.css'
import { type JobActions, JobLine } from '../Inbox/JobLine.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './Source.module.css'

/**
 * « Propose questions » on this source (whatever the « When I add a document » setting), where its proposals
 * stand, and how many wait in « To review ».
 */
export function Proposals({ sourceId }: { sourceId: Id }) {
  const t = useT()
  const rt = useRuntime()
  const queue = useAutoJobs(rt)
  const waiting = useWorkspaceData(
    ['drafts', 'sources', 'courses', 'sections'],
    (ws) => ws.drafts.list({ sourceId }).length,
  )
  const [asking, setAsking] = useState(false)
  const job = jobOf(queue.jobs, sourceId)
  const active = job !== undefined && isActiveJob(job)
  const propose = () => {
    setAsking(true)
    void proposeFor(rt, sourceId, 'manual').finally(() => setAsking(false))
  }
  const q = liveQueue()
  const act =
    (what: string, fn: (id: string) => Promise<void>) =>
    (id: string): void => {
      fn(id).catch((e: unknown) => noteError(`source.${what}`, e))
    }
  const actions: JobActions | undefined = q
    ? {
        cancel: act('cancel', (id) => q.cancel(id)),
        retry: act('retry', (id) => q.retry(id)),
        approve: act('approve', (id) => q.approve(id)),
      }
    : undefined
  return (
    <div className={styles.proposals}>
      <div className={styles.proposalsRow}>
        <Button icon={<Sparkles size={18} aria-hidden="true" />} loading={asking} disabled={active} onClick={propose}>
          {t('ai.sourcePropose')}
        </Button>
        {waiting > 0 && (
          <p className={inbox.line}>
            {t('ai.sourceProposed', { count: waiting })} ·{' '}
            <Link href={paths.inbox} className={inbox.link}>
              {t('ai.sourceReview')}
            </Link>
          </p>
        )}
      </div>
      {job && (active || job.status === 'failed') && <JobLine job={job} actions={actions} />}
    </div>
  )
}
