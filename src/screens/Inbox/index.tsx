import { Check, ChevronDown, Inbox as InboxIcon, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { type Runtime, useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { AiJob } from '../../core/ai/jobs'
import type { Id, StudyScope } from '../../core/contracts/workspace'
import type { Draft, DraftSourceGroup, DraftUnitGroup } from '../../core/model/drafts'
import type { SourceRecord } from '../../core/model/schema'
import { useT } from '../../i18n/react.tsx'
import { useAiReady, useDraftsShown } from '../../ui/ai/ready.ts'
import { useChat } from '../../ui/chat/context.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { jobOf, liveQueue, useAutoJobs } from '../../ui/data/autoQuestions.ts'
import { Screen } from '../../ui/shell/Screen.tsx'
import { type ScopeOption, scopeOptions, scopeValue } from '../SessionSetup/draft.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { DraftCard } from './DraftCard.tsx'
import styles from './Inbox.module.css'
import { type JobActions, JobLine, jobWorthShowing } from './JobLine.tsx'

type T = ReturnType<typeof useT>

/** How long an action can be undone before it is written. */
export const UNDO_MS = 6000

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

/** An action on suggestions, shown done at once and written once it can no longer be undone. */
interface Pending {
  kind: 'add' | 'reject'
  ids: readonly Id[]
  to?: StudyScope
  /** Cards edited before being added. */
  edits?: ReadonlyMap<Id, { front: string; back: string }>
  /** What the toast says. */
  message: string
}

/**
 * Actions undone before they are written: a rejection is final once written (it keeps the question from ever coming
 * back), so « Undo » belongs before the write. One action waits at a time: the next one, the end of its toast,
 * leaving the screen or the page write it.
 */
function usePending(rt: Runtime, onError: (e: unknown) => void) {
  const [pending, setPending] = useState<Pending | null>(null)
  const current = useRef<Pending | null>(null)
  const report = useRef(onError)
  report.current = onError

  const write = useCallback(
    (p: Pending) => {
      const ws = rt.ws
      try {
        ws.atomic(() => {
          for (const [id, e] of p.edits ?? []) if (ws.drafts.get(id)?.status === 'proposed') ws.drafts.edit(id, e)
          if (p.kind === 'add') ws.drafts.acceptAll(p.ids, p.to)
          else ws.drafts.rejectAll(p.ids)
        })
      } catch (e) {
        noteError(`inbox.${p.kind}`, e)
        report.current(e)
      }
    },
    [rt],
  )

  const flush = useCallback(() => {
    const p = current.current
    current.current = null
    setPending(null)
    if (p) write(p)
  }, [write])

  const act = useCallback(
    (p: Pending) => {
      const previous = current.current
      if (previous) write(previous)
      current.current = p
      setPending(p)
    },
    [write],
  )

  const undo = useCallback(() => {
    current.current = null
    setPending(null)
  }, [])

  // Written when its toast ends, when the screen closes, or when the page goes away.
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(flush, UNDO_MS)
    return () => clearTimeout(timer)
  }, [pending, flush])
  useEffect(() => {
    addEventListener('pagehide', flush)
    return () => {
      removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])

  return { pending, act, undo, flush }
}

interface Entry {
  source: SourceRecord
  course: string
  group?: DraftSourceGroup
  job?: AiJob
  at: number
}

/**
 * « Suggested cards »: the cards AI suggested on the sources the student asked about, grouped by source, then by
 * slide, page or section. Each card is added (to the place chosen for its source), edited then added, or rejected
 * at once, with a moment to undo; a whole group at once too. Jobs still running show first. Without a model, only
 * the cards already suggested show: no job, nothing about AI. With the AI's features hidden, none shows.
 */
export default function Inbox() {
  const t = useT()
  const rt = useRuntime()
  const ready = useAiReady()
  const shown = useDraftsShown()
  const chat = useChat()
  // Without a model the queue's code is never loaded: nothing could run.
  const queue = useAutoJobs(rt, { start: ready })
  const all = useWorkspaceData(['drafts', 'sources', 'courses', 'sections'], (ws) => ws.drafts.groups())
  const groups = shown ? all : []
  const summary = useWorkspaceData(['drafts', 'sources', 'courses', 'sections'], (ws) => ws.drafts.summary())
  const places = useWorkspaceData(['courses', 'sections'], scopeOptions)
  const [error, setError] = useState<string | null>(null)
  const { pending, act, undo, flush } = usePending(rt, (e) =>
    setError(t('ai.failed', { reason: e instanceof Error ? e.message : String(e) })),
  )
  const [filter, setFilter] = useState<Id | ''>('')
  const [destinations, setDestinations] = useState<ReadonlyMap<Id, StudyScope>>(new Map())
  const [editing, setEditing] = useState<Id | null>(null)
  const [focused, setFocused] = useState<Id | null>(null)
  const [refocus, setRefocus] = useState<Id | null>(null)
  useEffect(() => {
    if (refocus === null) return
    focusCard(refocus)
    setRefocus(null)
  }, [refocus])
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const filterId = useId()

  const now = Date.now()
  const hidden = new Set(pending?.ids ?? [])
  const latest = new Map(summary.sources.map((s) => [s.sourceId, s.latestAt]))
  const courseTitle = (id: Id) => rt.ws.courses.get(id)?.title ?? ''
  const entries = new Map<Id, Entry>()
  for (const g of groups) {
    const source = rt.ws.sources.get(g.sourceId)
    if (!source) continue
    entries.set(g.sourceId, { source, course: courseTitle(source.courseId), group: g, at: latest.get(g.sourceId) ?? 0 })
  }
  const jobs: { job: AiJob; source: SourceRecord }[] = []
  for (const sourceId of new Set(ready ? queue.jobs.map((j) => j.sourceId) : [])) {
    const job = jobOf(queue.jobs, sourceId)
    const known = entries.get(sourceId)
    if (!job || !jobWorthShowing(job, known !== undefined, now)) continue
    const source = rt.ws.sources.get(sourceId)
    if (!source || source.deletedAt !== undefined) continue
    jobs.push({ job, source })
    if (known) known.at = Math.max(known.at, job.updatedAt)
  }
  // Newest first; what is being undone stays out of sight.
  const list = [...entries.values()]
    .map((e) => ({
      ...e,
      units: (e.group?.units ?? [])
        .map((u) => ({ ...u, drafts: u.drafts.filter((d) => !hidden.has(d.id)).sort(byType) }))
        .filter((u) => u.drafts.length > 0),
    }))
    .filter((e) => e.units.length > 0)
    .sort((a, b) => b.at - a.at)
  const shownList = list.filter((e) => filter === '' || e.source.id === filter)
  const order = shownList.flatMap((e) =>
    e.units.flatMap((u) => (folded.has(`${e.source.id}:${u.unit}`) ? [] : u.drafts)),
  )
  const total = list.reduce((n, e) => n + e.units.reduce((m, u) => m + u.drafts.length, 0), 0)
  const current = order.find((d) => d.id === focused)?.id ?? order[0]?.id ?? null

  const q = liveQueue()
  const run = (what: string, fn: () => Promise<void>) => {
    fn().catch((e: unknown) => {
      noteError(`inbox.${what}`, e)
      setError(t('ai.failed', { reason: e instanceof Error ? e.message : String(e) }))
    })
  }
  const actions: JobActions | undefined = q
    ? { cancel: (id) => run('cancel', () => q.cancel(id)), retry: (id) => run('retry', () => q.retry(id)) }
    : undefined

  const destinationOf = (source: SourceRecord): StudyScope =>
    destinations.get(source.id) ??
    (source.sectionId === undefined
      ? { courseId: source.courseId }
      : { courseId: source.courseId, sectionId: source.sectionId })
  const placeName = (scope: StudyScope) =>
    places.find((p) => p.value === scopeValue(scope))?.label ?? courseTitle(scope.courseId)

  /** Moves the focus to the card after (or before) `id`, as it leaves the list. */
  const focusNext = (id: Id) => {
    const i = order.findIndex((d) => d.id === id)
    const next = order[i + 1] ?? order[i - 1]
    setFocused(next?.id ?? null)
    // Only when the card leaving had the focus (a key, or its own button): moved once the list is drawn again.
    if (next && document.activeElement?.closest('[data-draft]')) setRefocus(next.id)
  }
  const add = (source: SourceRecord, ids: readonly Id[], edit?: { id: Id; front: string; back: string }) => {
    setError(null)
    const to = destinationOf(source)
    const p: Pending = {
      kind: 'add',
      ids,
      to,
      message: t('ai.inboxAddedTo', { count: ids.length, place: placeName(to) }),
    }
    if (edit) p.edits = new Map([[edit.id, { front: edit.front, back: edit.back }]])
    if (ids.length === 1 && ids[0]) focusNext(ids[0])
    setEditing(null)
    act(p)
  }
  const reject = (ids: readonly Id[]) => {
    setError(null)
    if (ids.length === 1 && ids[0]) focusNext(ids[0])
    act({ kind: 'reject', ids, message: t('ai.inboxRejected', { count: ids.length }) })
  }

  // The keys of the focused card, read on the list (the cards are its focusable items).
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  const listRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const onKey = (e: KeyboardEvent) => keys.current(e)
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [])
  keys.current = (e: KeyboardEvent) => {
    const card = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-draft]') : null
    // Only on a card itself: typing in a field or the editor is typing.
    if (!card || e.target !== card || e.metaKey || e.ctrlKey || e.altKey) return
    const id = card.dataset.draft as Id
    const i = order.findIndex((d) => d.id === id)
    const entry = shownList.find((x) => x.units.some((u) => u.drafts.some((d) => d.id === id)))
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = order[e.key === 'ArrowDown' ? i + 1 : i - 1]
      if (next) {
        e.preventDefault()
        setFocused(next.id)
        focusCard(next.id)
      }
    } else if ((e.key === 'a' || e.key === 'A') && entry) {
      e.preventDefault()
      add(entry.source, [id])
    } else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault()
      setEditing(id)
    } else if (e.key === 'r' || e.key === 'R' || e.key === 'Delete') {
      e.preventDefault()
      reject([id])
    }
  }

  const empty = list.length === 0 && jobs.length === 0
  return (
    <Screen title={t('ai.inboxTitle')} back={paths.today}>
      {jobs.length > 0 && (
        <section className={styles.jobs} aria-labelledby="inbox-jobs">
          <h2 id="inbox-jobs" className={styles.sectionTitle}>
            {t('ai.inboxJobs')}
          </h2>
          <ul className={styles.jobList}>
            {jobs.map(({ job, source }) => (
              <li key={job.id} className={styles.jobItem}>
                <Link href={to.source(source.id)} className={styles.sourceLink}>
                  {source.title}
                </Link>
                <JobLine job={job} actions={actions} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {empty ? (
        <EmptyState
          icon={InboxIcon}
          title={t('ai.inboxEmptyTitle')}
          body={ready ? t('ai.inboxEmptyBody') : t('ai.inboxEmptyNoAi')}
          action={
            <div className={styles.emptyActions}>
              {ready && chat && (
                <Button
                  variant="primary"
                  icon={<Sparkles size={18} aria-hidden="true" />}
                  onClick={() => chat.run('generate')}
                >
                  {t('chat.actionGenerate')}
                </Button>
              )}
              <Link href={paths.courses} className={styles.link}>
                {t('ai.inboxToSources')}
              </Link>
            </div>
          }
        />
      ) : (
        list.length > 0 && (
          <>
            <div className={styles.toolbar}>
              <label className={styles.filterLabel} htmlFor={filterId}>
                {t('ai.inboxFilter')}
              </label>
              <select
                id={filterId}
                className={styles.select}
                value={filter}
                onChange={(e) => setFilter(e.target.value as Id | '')}
              >
                <option value="">{t('ai.inboxAllSources', { count: total })}</option>
                {list.map((e) => (
                  <option key={e.source.id} value={e.source.id}>
                    {t('ai.inboxSourceOption', {
                      title: e.source.title,
                      count: e.units.reduce((n, u) => n + u.drafts.length, 0),
                    })}
                  </option>
                ))}
              </select>
              <p className={styles.keys}>{t('ai.inboxKeys')}</p>
            </div>
            <div className={styles.list} ref={listRef}>
              {shownList.map((e) => (
                <SourceBlock
                  key={e.source.id}
                  entry={e}
                  units={e.units}
                  places={places}
                  destination={destinationOf(e.source)}
                  onDestination={(scope) => setDestinations((m) => new Map(m).set(e.source.id, scope))}
                  folded={folded}
                  onFold={(key) =>
                    setFolded((s) => {
                      const next = new Set(s)
                      if (!next.delete(key)) next.add(key)
                      return next
                    })
                  }
                  current={current}
                  editing={editing}
                  onFocus={setFocused}
                  onEdit={(id, on) => setEditing(on ? id : null)}
                  onAdd={(ids, edit) => add(e.source, ids, edit)}
                  onReject={reject}
                />
              ))}
            </div>
          </>
        )
      )}
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {pending && (
        <Toast
          message={pending.message}
          actions={[
            { label: t('common.undo'), onClick: undo },
            { label: t('common.dismiss'), onClick: flush },
          ]}
        />
      )}
    </Screen>
  )
}

function focusCard(id: Id) {
  document.querySelector<HTMLElement>(`[data-draft="${CSS.escape(id)}"]`)?.focus()
}

function SourceBlock({
  entry,
  units,
  places,
  destination,
  onDestination,
  folded,
  onFold,
  current,
  editing,
  onFocus,
  onEdit,
  onAdd,
  onReject,
}: {
  entry: Entry
  units: readonly DraftUnitGroup[]
  places: readonly ScopeOption[]
  destination: StudyScope
  onDestination(scope: StudyScope): void
  folded: ReadonlySet<string>
  onFold(key: string): void
  current: Id | null
  editing: Id | null
  onFocus(id: Id): void
  onEdit(id: Id, on: boolean): void
  onAdd(ids: readonly Id[], edit?: { id: Id; front: string; back: string }): void
  onReject(ids: readonly Id[]): void
}) {
  const t = useT()
  const { source } = entry
  const headingId = `inbox-${source.id}`
  const destinationId = useId()
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
      <div className={styles.destination}>
        <label className={styles.filterLabel} htmlFor={destinationId}>
          {t('ai.inboxDestination')}
        </label>
        <select
          id={destinationId}
          className={styles.select}
          value={scopeValue(destination)}
          onChange={(e) => {
            const picked = places.find((p) => p.value === e.target.value)
            if (picked?.scope.courseId) {
              onDestination(
                picked.scope.sectionId === undefined
                  ? { courseId: picked.scope.courseId }
                  : { courseId: picked.scope.courseId, sectionId: picked.scope.sectionId },
              )
            }
          }}
        >
          {places.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      {units.map((u) => {
        const key = `${source.id}:${u.unit}`
        const name = unitName(t, source, u)
        const open = !folded.has(key)
        const ids = u.drafts.map((d) => d.id)
        const unitId = `inbox-unit-${key}`
        return (
          <section key={key} className={styles.unit} aria-labelledby={unitId}>
            <div className={styles.unitHead}>
              <h3 id={unitId} className={styles.unitTitle}>
                <button
                  type="button"
                  className={styles.fold}
                  aria-expanded={open}
                  aria-controls={`${unitId}-list`}
                  onClick={() => onFold(key)}
                >
                  <ChevronDown size={18} aria-hidden="true" className={styles.chevron} />
                  {t('ai.inboxUnit', { name, count: u.drafts.length })}
                </button>
              </h3>
              {isDeck(source) && u.unit > 0 && (
                <Link href={`${to.source(source.id)}?page=${u.unit}`} className={styles.link}>
                  {t('ai.inboxOpenUnit')}
                </Link>
              )}
              <div className={styles.groupActions}>
                <Button
                  variant="secondary"
                  icon={<Check size={18} aria-hidden="true" />}
                  aria-label={t('ai.inboxAddAllOf', { name, count: ids.length })}
                  onClick={() => onAdd(ids)}
                >
                  {t('ai.inboxAddAll', { count: ids.length })}
                </Button>
                <Button
                  variant="plain"
                  icon={<X size={18} aria-hidden="true" />}
                  aria-label={t('ai.inboxRejectAllOf', { name })}
                  onClick={() => onReject(ids)}
                >
                  {t('ai.inboxRejectAll')}
                </Button>
              </div>
            </div>
            {open && (
              <ol id={`${unitId}-list`} className={styles.cards}>
                {u.drafts.map((d, i) => (
                  <DraftCard
                    key={d.id}
                    draft={d}
                    where={t('ai.deckWhere', { n: i + 1, name })}
                    current={d.id === current}
                    editing={editing === d.id}
                    onFocus={() => onFocus(d.id)}
                    onEdit={(on) => onEdit(d.id, on)}
                    onAdd={(edit) => onAdd([d.id], edit && { id: d.id, ...edit })}
                    onReject={() => onReject([d.id])}
                  />
                ))}
              </ol>
            )}
          </section>
        )
      })}
    </section>
  )
}
