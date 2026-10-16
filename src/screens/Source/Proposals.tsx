import { ScrollText, Sparkles } from 'lucide-react'
import { Link, useLocation } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id } from '../../core/contracts/workspace'
import { useT } from '../../i18n/react.tsx'
import { useAiReady, useDraftsShown } from '../../ui/ai/ready.ts'
import { useChat } from '../../ui/chat/context.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { isActiveJob, jobOf, liveQueue, useAutoJobs } from '../../ui/data/autoQuestions.ts'
import { createFiche, WRITE_QUERY } from '../Fiche/create.ts'
import inbox from '../Inbox/Inbox.module.css'
import { type JobActions, JobLine } from '../Inbox/JobLine.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './Source.module.css'

/**
 * The source's AI actions: « Suggest cards » (whatever the « When I add a document » setting), followed in the chat
 * beside it, and « Summarise this source » (when a model has something to read in it, `readable`), a study sheet of
 * the source written by AI on its own screen; then where its proposals stand, and how many wait in « Suggested
 * cards ». Without a model only the cards already suggested show.
 */
export function Proposals({ sourceId, readable }: { sourceId: Id; readable: boolean }) {
  const t = useT()
  const rt = useRuntime()
  const ready = useAiReady()
  const shown = useDraftsShown()
  const queue = useAutoJobs(rt)
  const waiting = useWorkspaceData(
    ['drafts', 'sources', 'courses', 'sections'],
    (ws) => ws.drafts.list({ sourceId }).length,
  )
  const chat = useChat()
  const [, navigate] = useLocation()
  const summarise = () => {
    const source = rt.ws.sources.get(sourceId)
    if (!source) return
    const sectionId = rt.ws.sections.tree().sectionOf(source)
    const place = sectionId === null ? { courseId: source.courseId } : { courseId: source.courseId, sectionId }
    navigate(`${to.fiche(createFiche(rt.ws, place, source.title, [source.id]))}?${WRITE_QUERY}`)
  }
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
  if (!ready && (waiting === 0 || !shown)) return null
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
        {ready && readable && (
          <Button variant="plain" icon={<ScrollText size={18} aria-hidden="true" />} onClick={summarise}>
            {t('chat.actionSummarise')}
          </Button>
        )}
        {waiting > 0 && shown && (
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
