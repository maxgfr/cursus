import { ScrollText, Sparkles } from 'lucide-react'
import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id } from '../../core/contracts/workspace'
import { useT } from '../../i18n/react.tsx'
import { useAiReady } from '../../ui/ai/ready.ts'
import { useChat } from '../../ui/chat/context.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { isActiveJob, jobOf, liveQueue, useAutoJobs } from '../../ui/data/autoQuestions.ts'
import inbox from '../Inbox/Inbox.module.css'
import { type JobActions, JobLine } from '../Inbox/JobLine.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './Source.module.css'

/**
 * The source's AI actions, each answered in the chat beside it: « Suggest cards » (whatever the « When I add a
 * document » setting) and « Summarise this source » (when a model has something to read in it, `readable`); then
 * where its proposals stand, and how many wait in « Suggested cards ». Without a model only the cards already
 * suggested show.
 */
export function Proposals({ sourceId, readable }: { sourceId: Id; readable: boolean }) {
  const t = useT()
  const rt = useRuntime()
  const ready = useAiReady()
  const queue = useAutoJobs(rt)
  const waiting = useWorkspaceData(
    ['drafts', 'sources', 'courses', 'sections'],
    (ws) => ws.drafts.list({ sourceId }).length,
  )
  const chat = useChat()
  // Slides and documents offer « Create cards » with their content (DeckView): the same queue, one button.
  const deck = useWorkspaceData([{ id: sourceId }], (ws) => ws.sources.get(sourceId)?.support !== undefined)
  const job = jobOf(queue.jobs, sourceId)
  const active = job !== undefined && isActiveJob(job)
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
      }
    : undefined
  if (!ready && waiting === 0) return null
  return (
    <div className={styles.proposals}>
      <div className={styles.proposalsRow}>
        {ready && chat && !deck && (
          // Proposed by the background queue, followed in the chat beside the source.
          <Button
            icon={<Sparkles size={18} aria-hidden="true" />}
            disabled={active}
            onClick={() => chat.run('suggestCards')}
          >
            {t('ai.sourcePropose')}
          </Button>
        )}
        {ready && chat && readable && (
          <Button
            variant="plain"
            icon={<ScrollText size={18} aria-hidden="true" />}
            onClick={() => chat.run('summarise')}
          >
            {t('chat.actionSummarise')}
          </Button>
        )}
        {waiting > 0 && (
          <p className={inbox.line}>
            {t('ai.sourceProposed', { count: waiting })} ·{' '}
            <Link href={paths.inbox} className={inbox.link}>
              {t('ai.sourceReview')}
            </Link>
          </p>
        )}
      </div>
      {ready && job && (active || job.status === 'failed') && <JobLine job={job} actions={actions} />}
    </div>
  )
}
