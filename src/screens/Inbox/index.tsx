import { Check, Inbox as InboxIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { AiJob } from '../../core/ai/jobs'
import type { Id } from '../../core/contracts/workspace'
import type { Draft, DraftSourceGroup, DraftUnitGroup } from '../../core/model/drafts'
import type { SourceRecord } from '../../core/model/schema'
import { useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { jobOf, liveQueue, useAutoJobs } from '../../ui/data/autoQuestions.ts'
import { Screen } from '../../ui/shell/Screen.tsx'
import { type LoadedDeck, loadDeck } from '../DeckImport/deckSource.ts'
import { useUnitThumbs } from '../DeckImport/thumbs.ts'
import { type DraftGroup, DraftReview, type ReviewDraft } from '../Generate/DraftReview.tsx'
import { useThumbs } from '../Photos/files.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import styles from './Inbox.module.css'
import { type JobActions, JobLine, jobWorthShowing } from './JobLine.tsx'

type Decision = 'accepted' | 'rejected'
type Edit = { front?: string; back?: string }
type T = ReturnType<typeof useT>

const HAS_CLOZE = /\{\{c\d+::.+?\}\}/s

/** « Slide 3 », « Page 2 », « Section 4 », « Photo »: how a draft's unit is cited. */
function unitName(t: T, source: SourceRecord, u: Pick<DraftUnitGroup, 'unit' | 'unitKind' | 'unitLabel'>): string {
  if (source.kind === 'image') return t('ai.inboxPhoto')
  if (u.unit === 0) return t('ai.inboxWhole')
  const n = u.unitLabel ?? String(u.unit)
  if (u.unitKind === 'slide') return t('ai.deckSlide', { n })
  if (u.unitKind === 'section') return n === '0' ? t('ai.deckIntro') : t('ai.deckSection', { n })
  return t('ai.deckPage', { n })
}

const isDeck = (s: SourceRecord) => s.kind === 'pdf' || s.support !== undefined

/** Within a unit: questions, then fill-in-the-blanks, then « in your own words » (drafts written together share an instant). */
const TYPE_ORDER: Readonly<Record<Draft['type'], number>> = { qa: 0, cloze: 1, explain: 2 }
const byType = (a: Draft, b: Draft) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.createdAt - b.createdAt

/**
 * The source's deck read from this device, for its unit titles and thumbnails: only while it has questions to
 * show (null otherwise, or when it isn't one).
 */
function useDeck(source: SourceRecord, wanted: boolean): LoadedDeck | null {
  const rt = useRuntime()
  const [loaded, setLoaded] = useState<LoadedDeck | null>(null)
  const deck = wanted && isDeck(source)
  const { blobId, title } = source
  useEffect(() => {
    if (!deck) return
    let live = true
    loadDeck(rt, { blobId, title }).then(
      (l) => {
        if (live) setLoaded(l)
      },
      // Only pictures and titles: the questions show without them.
      (e: unknown) => noteError('inbox.deck', e),
    )
    return () => {
      live = false
    }
  }, [rt, deck, blobId, title])
  return loaded
}

interface Entry {
  source: SourceRecord
  course: string
  group?: DraftSourceGroup
  job?: AiJob
  at: number
}

interface Local {
  decisions: ReadonlyMap<Id, Decision>
  edits: ReadonlyMap<Id, Edit>
  onAccept(ids: readonly string[]): void
  onReject(ids: readonly string[]): void
  onRestore(ids: readonly string[]): void
  onEdit(id: string, patch: Edit): void
}

function SourceBlock({ entry, actions, local }: { entry: Entry; actions: JobActions | undefined; local: Local }) {
  const t = useT()
  const { source, group, job } = entry
  const deck = useDeck(source, (group?.units.length ?? 0) > 0)
  // Pictures of slides and documents only: a PDF page would have to be drawn (heavy, and pdf.js may be unreachable offline).
  const deckThumbs = useUnitThumbs(deck?.deck.format === 'pdf' ? null : deck)
  const photoThumbs = useThumbs(source.kind === 'image' && source.blobId ? [source.blobId] : [])
  const headingId = `inbox-${source.id}`
  const groups: DraftGroup[] = (group?.units ?? []).map((u) => {
    const unit = deck?.deck.units.find((x) => x.index === u.unit)
    const thumb = source.kind === 'image' && source.blobId ? photoThumbs.get(source.blobId) : deckThumbs.get(u.unit)
    const g: DraftGroup = {
      key: `${source.id}:${u.unit}`,
      name: unitName(t, source, u),
      drafts: [...u.drafts].sort(byType).map((d): ReviewDraft => {
        const e = local.edits.get(d.id)
        const r: ReviewDraft = {
          id: d.id,
          kind: d.kind,
          front: e?.front ?? d.front,
          back: e?.back ?? d.back,
          status: local.decisions.get(d.id) ?? 'pending',
          type: d.type,
        }
        if (d.difficulty !== undefined) r.difficulty = d.difficulty
        if (d.quote !== undefined) r.quote = d.quote
        return r
      }),
    }
    if (unit?.title) g.title = unit.title
    if (isDeck(source) && u.unit > 0) g.href = `${to.source(source.id)}?page=${u.unit}`
    if (thumb && 'url' in thumb) g.thumb = { url: thumb.url, alt: '' }
    return g
  })
  return (
    <section className={styles.source} aria-labelledby={headingId}>
      <div className={styles.sourceHead}>
        <h2 id={headingId} className={styles.sourceTitle}>
          <Link href={to.source(source.id)} className={styles.sourceLink}>
            {source.title}
          </Link>
        </h2>
        <p className={styles.meta}>{t('ai.inboxInCourse', { course: entry.course })}</p>
      </div>
      {job && <JobLine job={job} actions={actions} />}
      {groups.length > 0 && (
        <DraftReview
          groups={groups}
          level={3}
          onAccept={local.onAccept}
          onReject={local.onReject}
          onRestore={local.onRestore}
          onEdit={local.onEdit}
        />
      )}
    </section>
  )
}

/**
 * « À relire »: the questions AI proposed on the documents added, grouped by document and by slide, page or
 * section, with each document's progress. Accept all, one by one, edit or reject; nothing is written until
 * Save (a rejection is final, so it can be undone only before), and rejected questions never come back.
 */
export default function Inbox() {
  const t = useT()
  const rt = useRuntime()
  const queue = useAutoJobs(rt, { start: true })
  const model = useAiModel()
  const groups = useWorkspaceData(['drafts', 'sources', 'courses', 'sections'], (ws) => ws.drafts.groups())
  const summary = useWorkspaceData(['drafts', 'sources', 'courses', 'sections'], (ws) => ws.drafts.summary())
  const [decisions, setDecisions] = useState<ReadonlyMap<Id, Decision>>(new Map())
  const [edits, setEdits] = useState<ReadonlyMap<Id, Edit>>(new Map())
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const now = Date.now()
  const latest = new Map(summary.sources.map((s) => [s.sourceId, s.latestAt]))
  const entries = new Map<Id, Entry>()
  const courseTitle = (id: Id) => rt.ws.courses.get(id)?.title ?? ''
  for (const g of groups) {
    const source = rt.ws.sources.get(g.sourceId)
    if (!source) continue
    entries.set(g.sourceId, { source, course: courseTitle(source.courseId), group: g, at: latest.get(g.sourceId) ?? 0 })
  }
  for (const sourceId of new Set(queue.jobs.map((j) => j.sourceId))) {
    const job = jobOf(queue.jobs, sourceId)
    const known = entries.get(sourceId)
    if (!job || !jobWorthShowing(job, known !== undefined, now)) continue
    if (known) {
      known.job = job
      known.at = Math.max(known.at, job.updatedAt)
      continue
    }
    const source = rt.ws.sources.get(sourceId)
    if (!source || source.deletedAt !== undefined) continue
    entries.set(sourceId, { source, course: courseTitle(source.courseId), job, at: job.updatedAt })
  }
  const list = [...entries.values()].sort((a, b) => b.at - a.at)
  const waitingForModel = queue.jobs.some((j) => j.status === 'needs-model')

  const q = liveQueue()
  const run = (what: string, fn: () => Promise<void>) => {
    fn().catch((e: unknown) => {
      noteError(`inbox.${what}`, e)
      setError(t('ai.failed', { reason: e instanceof Error ? e.message : String(e) }))
    })
  }
  const actions: JobActions | undefined = q
    ? {
        cancel: (id) => run('cancel', () => q.cancel(id)),
        retry: (id) => run('retry', () => q.retry(id)),
        approve: (id) => run('approve', () => q.approve(id)),
      }
    : undefined

  const decide = (ids: readonly string[], d: Decision | null) =>
    setDecisions((m) => {
      const next = new Map(m)
      for (const id of ids) {
        if (d === null) next.delete(id)
        else next.set(id, d)
      }
      return next
    })
  const local: Local = {
    decisions,
    edits,
    onAccept: (ids) => decide(ids, 'accepted'),
    onReject: (ids) => decide(ids, 'rejected'),
    onRestore: (ids) => decide(ids, null),
    onEdit: (id, patch) => setEdits((m) => new Map(m).set(id, { ...m.get(id), ...patch })),
  }

  const accepted = [...decisions].filter(([, d]) => d === 'accepted').map(([id]) => id)
  const rejected = [...decisions].filter(([, d]) => d === 'rejected').map(([id]) => id)
  const dirty = accepted.length + rejected.length + edits.size > 0

  const save = () => {
    setError(null)
    const ws = rt.ws
    const toEdit: [Id, Edit][] = []
    for (const [id, e] of edits) {
      const d = ws.drafts.get(id)
      if (d?.status !== 'proposed' || decisions.get(id) === 'rejected') continue
      const front = e.front ?? d.front
      if (front.trim() === '' || (d.kind === 'cloze' && !HAS_CLOZE.test(front))) {
        setError(t('ai.inboxInvalid'))
        return
      }
      toEdit.push([id, e])
    }
    try {
      const cards = ws.atomic(() => {
        for (const [id, e] of toEdit) ws.drafts.edit(id, e)
        ws.drafts.rejectAll(rejected)
        return ws.drafts.acceptAll(accepted)
      })
      setDecisions(new Map())
      setEdits(new Map())
      setNotice(cards.length > 0 ? t('ai.inboxSaved', { count: cards.length }) : t('ai.inboxChangesSaved'))
    } catch (e) {
      noteError('inbox.save', e)
      setError(t('ai.failed', { reason: e instanceof Error ? e.message : String(e) }))
    }
  }

  const invitation = (waitingForModel || (list.length === 0 && model.status === 'missing')) && (
    <div className={styles.invite}>
      <p className={styles.inviteText}>{t('ai.inboxNeedsModel')}</p>
      <Link href={paths.settingsAi} className={buttonClass({ variant: 'secondary' })}>
        {t('ai.openSettings')}
      </Link>
    </div>
  )

  return (
    <Screen title={t('ai.inboxTitle')} back={paths.today}>
      {invitation}
      {list.length === 0 ? (
        <EmptyState
          icon={InboxIcon}
          title={t('ai.inboxEmptyTitle')}
          body={rt.ws.drafts.settings.get().mode === 'off' ? t('ai.inboxEmptyOff') : t('ai.inboxEmptyBody')}
        />
      ) : (
        list.map((e) => <SourceBlock key={e.source.id} entry={e} actions={actions} local={local} />)
      )}
      {dirty && (
        <div className={styles.saveBar}>
          <Button variant="primary" icon={<Check size={18} aria-hidden="true" />} onClick={save}>
            {accepted.length > 0 ? t('ai.inboxSave', { count: accepted.length }) : t('ai.inboxSaveChanges')}
          </Button>
          {rejected.length > 0 && <p className={styles.meta}>{t('ai.inboxSaveHint')}</p>}
        </div>
      )}
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice !== null && (
        <Toast message={notice} actions={[{ label: t('common.dismiss'), onClick: () => setNotice(null) }]} />
      )}
    </Screen>
  )
}
