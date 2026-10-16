import type { DeepPartial } from 'ai'
import { Check, ChevronDown, Library, MessageCircle, NotebookText, RotateCcw, Trash2 } from 'lucide-react'
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { answerTerms, guardAnswer } from '../../core/ai/features/explainQuestion'
import type { ChatDraft, RichResult, StudyOptions } from '../../core/ai/features/tutorChat'
import type { Detail } from '../../core/ai/features/understand'
import type { Chunk } from '../../core/ai/retrieval'
import type {
  CardImprovement,
  ExplainBackReview,
  PhotoDescription,
  QuizQuestion,
  SourceRef,
  Understanding,
} from '../../core/ai/schemas'
import { getPhoto, listPhotos, type Photo, photoLabel } from '../../core/model/photos'
import { weakCards } from '../../core/model/quizPlan'
import type { ModelWorkspace } from '../../core/model/workspace'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import type { CardNotice } from '../../screens/Course/View.tsx'
import { JobLine, jobWorthShowing } from '../../screens/Inbox/JobLine.tsx'
import { useThumbs } from '../../screens/Photos/files.ts'
import { noteError } from '../../screens/settings/Diagnostic/recent.ts'
import shared from '../../screens/Understand/shared/ai.module.css'
import {
  Citation,
  type Selection,
  SourcePicker,
  useScopedSources,
} from '../../screens/Understand/shared/SourcePicker.tsx'
import { estimateCost, PASTED } from '../../screens/Understand/shared/sources.ts'
import { ExplainBack } from '../ai/ExplainBack.tsx'
import { keyedChoices } from '../ai/keyed.ts'
import { QuizStep } from '../ai/QuizStep.tsx'
import { sourcesSummary } from '../ai/summary.ts'
import { Button } from '../components/Button.tsx'
import { Field } from '../components/Field.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { Segmented } from '../components/Segmented.tsx'
import { cx } from '../cx.ts'
import { isActiveJob, jobOf, liveQueue, useAutoJobs } from '../data/autoQuestions.ts'
import { streamedKeys } from '../data/usePartial.ts'
import { askAbout, keepSelection, useSelectedTerm } from '../ExplainLauncher.tsx'
import { Sanitized } from '../render/Sanitized.tsx'
import type { StudyKind } from './actions.ts'
import { useChat } from './context.tsx'
import { QuizFields } from './QuizFields.tsx'
import styles from './Study.module.css'
import { photoCardsCost, photoCost, type ReadyModel } from './studyRun.ts'

type T = ReturnType<typeof useT>
type StudyRich = Exclude<RichResult, { kind: 'explainQuestion' | 'explainCard' }>

/** What the study answers act through: the thread, its model and its sources. Provided by the chat panel. */
export interface StudyApi {
  ai: ReadyModel
  /** The thread is writing an answer, or the model can't be called (offline): no action starts. */
  blocked: boolean
  load: (o: Pick<StudyOptions, 'sourceIds' | 'pasted'>) => Promise<Chunk[]>
  /** Keeps a changed answer (a card saved, a quiz answered) in the thread. */
  update: (id: string, rich: RichResult) => void
  /** Runs a study action again in place, with changed options. */
  rerun: (id: string, kind: StudyKind, options: StudyOptions) => void
  /** Grades the card on screen (these faces) from the thread. */
  rate: (card: { front: string; back: string }, rating: 1 | 2 | 3 | 4) => void
  /** Starts another study action below (a study sheet from a photo's place). */
  start: (kind: StudyKind, options: StudyOptions) => void
  /** Reads a photo again, or drafts cards from photos, as a new answer. */
  explainPhoto: (photoId: string) => void
  photoCards: (courseId: string, photoIds: string[], count: number) => void
  /** The student's explanation of a sheet's topic, checked against its sources. */
  checkExplanation: (
    options: StudyOptions,
    explanation: string,
    onPartial: (p: unknown) => void,
  ) => Promise<ExplainBackReview>
}

const Api = createContext<StudyApi | null>(null)
export const StudyProvider = Api.Provider

function useApi(): StudyApi {
  const api = useContext(Api)
  if (!api) throw new Error('StudyAnswer outside the chat panel')
  return api
}

const useCost = () => {
  const t = useT()
  const locale = useLocale()
  return (ai: ReadyModel, amount: number) => `${t('ai.cost', { amount: formatUsd(locale, amount) })} · ${ai.info.name}`
}

/**
 * A structured answer of a study action, with its buttons and its options to run it again. `revealed`: the card's
 * answer may show; `onScreen`: a grade is about the card on screen, which can still take it.
 */
export function StudyAnswer({
  id,
  rich,
  revealed,
  onScreen = false,
}: {
  id: string
  rich: StudyRich
  revealed: boolean
  onScreen?: boolean
}) {
  switch (rich.kind) {
    case 'cards':
      return <CardsAnswer id={id} rich={rich} />
    case 'quiz':
      return <QuizAnswer id={id} rich={rich} />
    case 'sheet':
      return <SheetAnswer id={id} rich={rich} />
    case 'grade':
      return <GradeAnswer id={id} rich={rich} revealed={revealed} onScreen={onScreen} />
    case 'photo':
      return <PhotoAnswer rich={rich} />
    case 'improve':
      return <ImproveAnswer id={id} rich={rich} revealed={revealed} />
    case 'job':
      return <JobAnswer sourceId={rich.sourceId} />
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={shared.label}>
        {title}
      </h3>
      {children}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Options

const CARD_COUNTS = ['5', '10', '20'] as const

const selectionOf = (o: StudyOptions): Selection => ({
  courseId: o.courseId,
  sectionId: o.sectionId ?? '',
  sourceIds: o.sourceIds,
  pasted: o.pasted,
})

function withSelection(o: StudyOptions, s: Selection): StudyOptions {
  const { sectionId: _, ...rest } = o
  return {
    ...rest,
    courseId: s.courseId,
    ...(s.sectionId ? { sectionId: s.sectionId } : {}),
    sourceIds: s.sourceIds,
    pasted: s.pasted,
  }
}

function usePlace(o: Pick<StudyOptions, 'courseId' | 'sectionId'>): string {
  return useWorkspaceData(['courses', 'sections', { id: `${o.courseId}/${o.sectionId ?? ''}` }], (ws) => {
    const section = o.sectionId ? ws.sections.get(o.sectionId) : undefined
    return section?.name ?? ws.courses.get(o.courseId)?.title ?? ''
  })
}

function amountOf(t: T, kind: StudyKind, o: StudyOptions): string {
  if (kind === 'understand') {
    const detail: Record<Detail, string> = {
      short: t('ai.detailShort'),
      standard: t('ai.detailStandard'),
      deep: t('ai.detailDeep'),
    }
    return detail[o.detail]
  }
  if (kind === 'quiz') return o.count === 'all' ? t('chat.allQuestions') : t('chat.questions', { count: o.count })
  return t('chat.cards', { count: o.count === 'all' ? 10 : o.count })
}

/**
 * What an action ran with, in one line (« 10 cards · Sources: all of Biology »), unfolding into its options: the
 * topic, how many, how deep, the sources. « Run again » writes the answer again with them.
 */
function Options({ id, kind, options }: { id: string; kind: StudyKind; options: StudyOptions }) {
  const t = useT()
  const api = useApi()
  const cost = useCost()
  const [o, setO] = useState(options)
  useEffect(() => setO(options), [options])
  const place = usePlace(o)
  const scoped = useScopedSources({ courseId: o.courseId, sectionId: o.sectionId ?? '' })
  const ws = useWorkspace()
  // The place's weak points, for a quiz to ask about first.
  const weak = useWorkspaceData(
    ['cards', 'reviews', 'sections', 'prefs', { id: `${o.courseId}/${o.sectionId ?? ''}` }],
    (w) =>
      kind !== 'quiz' || o.courseId === ''
        ? 0
        : weakCards(
            w,
            o.sectionId ? { courseId: o.courseId, sectionId: o.sectionId } : { courseId: o.courseId },
            Date.now(),
          ).length,
  )
  const [estimate, setEstimate] = useState<number | null>(null)
  const [photosRead, setPhotosRead] = useState(0)
  const { ai, load } = api
  useEffect(() => {
    let live = true
    load(o).then(
      (chunks) => {
        if (!live) return
        const tokens = kind === 'generate' ? 150 * Number(o.count === 'all' ? 10 : o.count) : undefined
        setEstimate(estimateCost(ai.info, chunks, tokens))
        setPhotosRead(
          new Set(chunks.filter((c) => ws.sources.get(c.sourceId)?.kind === 'image').map((c) => c.sourceId)).size,
        )
      },
      () => {
        if (live) setEstimate(null)
      },
    )
    return () => {
      live = false
    }
  }, [o, load, ai, kind, ws])
  const chosen = scoped.filter((s) => o.sourceIds.includes(s.id)).length
  const used = sourcesSummary(t, { place, chosen, total: scoped.length, pasted: o.pasted.trim() !== '' })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (kind === 'understand' && o.topic.trim() === '') return
    api.rerun(id, kind, o)
  }
  return (
    <form className={shared.tight} onSubmit={submit}>
      <details className={shared.disclosure}>
        <summary className={shared.disclosureSummary}>
          <Library size={18} aria-hidden="true" className={shared.checkIcon} />
          <span className={shared.disclosureLabel}>
            {amountOf(t, kind, o)} · {used}
          </span>
          <ChevronDown size={18} aria-hidden="true" className={shared.chevron} />
        </summary>
        <div className={shared.disclosureBody}>
          {kind === 'understand' ? (
            <Field
              label={t('ai.sheetTopic')}
              hint={t('ai.sheetTopicHint')}
              value={o.topic}
              onChange={(e) => setO({ ...o, topic: e.target.value })}
              enterKeyHint="go"
            />
          ) : (
            <Field
              label={t('ai.topicOptional')}
              value={o.topic}
              onChange={(e) => setO({ ...o, topic: e.target.value })}
            />
          )}
          {kind === 'understand' && (
            <Segmented<Detail>
              label={t('ai.detail')}
              value={o.detail}
              onChange={(detail) => setO({ ...o, detail })}
              options={[
                { value: 'short', label: t('ai.detailShort') },
                { value: 'standard', label: t('ai.detailStandard') },
                { value: 'deep', label: t('ai.detailDeep') },
              ]}
            />
          )}
          {kind === 'generate' && (
            <Segmented
              label={t('ai.cardCount')}
              value={String(o.count) as (typeof CARD_COUNTS)[number]}
              onChange={(c) => setO({ ...o, count: Number(c) })}
              options={CARD_COUNTS.map((c) => ({ value: c, label: c }))}
            />
          )}
          {kind === 'quiz' && <QuizFields value={o} onChange={(patch) => setO({ ...o, ...patch })} weak={weak} />}
          <SourcePicker value={selectionOf(o)} onChange={(s) => setO(withSelection(o, s))} chosen />
          {kind === 'understand' && photosRead > 0 && (
            <p className={shared.hint}>{t('photos.aiUnderstandPhotos', { count: photosRead })}</p>
          )}
        </div>
      </details>
      <div className={shared.row}>
        <Button
          type="submit"
          variant="secondary"
          icon={<RotateCcw size={18} aria-hidden="true" />}
          disabled={api.blocked || (kind === 'understand' && o.topic.trim() === '')}
        >
          {t('chat.rerun')}
        </Button>
        {estimate !== null && <span className={shared.hint}>{cost(ai, estimate)}</span>}
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Cards

/** Where a saved card goes: the options' course or section, or for a photo's card where its photo is. */
function saveDraft(ws: ModelWorkspace, rich: Extract<RichResult, { kind: 'cards' }>, d: ChatDraft): string {
  const { courseId } = rich.options
  return ws.batch(() => {
    let place: { sectionId?: string } = rich.options.sectionId ? { sectionId: rich.options.sectionId } : {}
    let sourceId = d.sourceRef && d.sourceRef.sourceId !== PASTED ? d.sourceRef.sourceId : undefined
    if (rich.photoIds) {
      const from = getPhoto(ws, d.sourceRef?.sourceId ?? '') ?? getPhoto(ws, rich.photoIds[0] ?? '')
      place = from?.sectionId ? { sectionId: from.sectionId } : {}
      sourceId = from?.id
    }
    const id = ws.cards.create({ courseId, ...place, kind: d.kind, origin: 'ai', sourceId })
    ws.text({ id, field: 'front' }).insert(0, d.front.trim())
    if (d.back.trim()) ws.text({ id, field: 'back' }).insert(0, d.back.trim())
    return id
  })
}

const pendingDraft = (d: ChatDraft) => !d.removed && d.savedId === undefined && d.front.trim() !== ''

function CardsAnswer({ id, rich }: { id: string; rich: Extract<RichResult, { kind: 'cards' }> }) {
  const t = useT()
  const ws = useWorkspace()
  const api = useApi()
  const [saved, setSaved] = useState<number | null>(null)
  const shown = rich.drafts.map((d, at) => ({ d, at })).filter(({ d }) => !d.removed)
  const kept = shown.filter(({ d }) => !d.duplicate)
  const duplicates = shown.length - kept.length
  // « Save all » leaves out what the course already has: a duplicate is saved only on its own.
  const toSave = rich.drafts.filter((d) => pendingDraft(d) && !d.duplicate)
  const set = (drafts: ChatDraft[]) => api.update(id, { ...rich, drafts })
  const edit = (at: number, patch: Partial<ChatDraft>) =>
    set(rich.drafts.map((d, i) => (i === at ? { ...d, ...patch } : d)))
  const saveOne = (at: number) => {
    const d = rich.drafts[at]
    if (!d || !pendingDraft(d)) return
    edit(at, { savedId: saveDraft(ws, rich, d) })
  }
  const saveAll = () => {
    const drafts = rich.drafts.map((d) =>
      pendingDraft(d) && !d.duplicate ? { ...d, savedId: saveDraft(ws, rich, d) } : d,
    )
    setSaved(toSave.length)
    set(drafts)
  }
  const discard = () => set(rich.drafts.map((d) => (d.savedId === undefined ? { ...d, removed: true } : d)))
  const place = rich.options
  if (rich.empty) return <NothingToRead id={id} kind="generate" options={rich.options} />
  return (
    <section className={shared.stack} aria-label={t('ai.drafts')}>
      <div className={shared.tight} role="status">
        <p className={shared.heading}>{t('ai.generated', { count: kept.length })}</p>
        {duplicates > 0 && <p className={shared.hint}>{t('chat.duplicatesFlagged', { count: duplicates })}</p>}
      </div>
      {shown.length > 0 ? (
        <ol className={shared.list}>
          {shown.map(({ d, at }, n) => (
            <DraftItem
              key={`draft-${at + 1}`}
              draft={d}
              index={n + 1}
              onChange={(patch) => edit(at, patch)}
              onRemove={() => edit(at, { removed: true })}
              onSave={() => saveOne(at)}
            />
          ))}
        </ol>
      ) : (
        <p className={shared.hint}>{t('ai.deckDiscarded')}</p>
      )}
      {toSave.length > 0 && (
        <div className={shared.row}>
          <Button variant="primary" onClick={saveAll}>
            {t('ai.saveCards', { count: toSave.length })}
          </Button>
          <Button variant="plain" onClick={discard}>
            {t('ai.discard')}
          </Button>
        </div>
      )}
      {saved !== null && (
        <p className={shared.success} role="status">
          {t('ai.saved', { count: saved })}{' '}
          <Link href={to.place(place.courseId, place.sectionId)}>{t('ai.openCourse')}</Link>
        </p>
      )}
      {!rich.photoIds && <Options id={id} kind="generate" options={rich.options} />}
    </section>
  )
}

function DraftItem({
  draft,
  index,
  onChange,
  onRemove,
  onSave,
}: {
  draft: ChatDraft
  index: number
  onChange: (p: Partial<ChatDraft>) => void
  onRemove: () => void
  onSave: () => void
}) {
  const t = useT()
  const id = useId()
  const done = draft.savedId !== undefined
  return (
    <li className={cx(shared.card, styles.draft)} data-duplicate={draft.duplicate || undefined}>
      <div className={shared.row}>
        <span className={shared.badge}>{draft.kind === 'cloze' ? t('ai.kindCloze') : t('ai.kindBasic')}</span>
        {draft.duplicate && <span className={shared.badge}>{t('chat.duplicate')}</span>}
        {draft.sourceRef && <Citation sourceRef={draft.sourceRef} />}
        <span className={shared.spacer} />
        {!done && <IconButton icon={Trash2} label={t('ai.removeDraft', { n: String(index) })} onClick={onRemove} />}
      </div>
      <div className={shared.field}>
        <label className={shared.label} htmlFor={`${id}-f`}>
          {t('ai.front', { n: String(index) })}
        </label>
        <textarea
          id={`${id}-f`}
          className={shared.textarea}
          rows={2}
          value={draft.front}
          readOnly={done}
          onChange={(e) => onChange({ front: e.target.value })}
        />
      </div>
      {draft.kind === 'basic' && (
        <div className={shared.field}>
          <label className={shared.label} htmlFor={`${id}-b`}>
            {t('ai.back', { n: String(index) })}
          </label>
          <textarea
            id={`${id}-b`}
            className={shared.textarea}
            rows={2}
            value={draft.back}
            readOnly={done}
            onChange={(e) => onChange({ back: e.target.value })}
          />
        </div>
      )}
      <div className={shared.row}>
        {done && draft.savedId ? (
          <p className={cx(shared.success, styles.saved)}>
            <Check size={14} aria-hidden="true" />
            <span>{t('chat.cardSaved')}</span>
            <Link href={to.card(draft.savedId)}>{t('chat.editCard')}</Link>
          </p>
        ) : (
          <Button
            variant="plain"
            aria-label={t('chat.saveCardN', { n: String(index) })}
            disabled={draft.front.trim() === ''}
            onClick={onSave}
          >
            {t('chat.saveCard')}
          </Button>
        )}
      </div>
    </li>
  )
}

/** Cards as they are written. */
export function PartialCards({ partial }: { partial: DeepPartial<{ cards: ChatDraft[] }> | null }) {
  const t = useT()
  const writing = (partial?.cards ?? []).filter((c) => c?.front)
  if (writing.length === 0) return null
  return (
    <section className={shared.stack} aria-label={t('ai.drafts')} aria-busy="true">
      <p className={shared.heading}>{t('ai.writingCards', { count: writing.length })}</p>
      <ol className={shared.list}>
        {streamedKeys(writing).map(({ item: c, key, last }) => (
          <li key={key} className={shared.card}>
            <p className={shared.body}>{last && !c?.back ? `${c?.front ?? ''} ▍` : c?.front}</p>
            {c?.back && <p className={shared.muted}>{last ? `${c.back} ▍` : c.back}</p>}
          </li>
        ))}
      </ol>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Quiz

/** One question at a time: a choice shows its correction, then the next question; the score at the end. Never graded into the schedule. */
function QuizAnswer({ id, rich }: { id: string; rich: Extract<RichResult, { kind: 'quiz' }> }) {
  const t = useT()
  const api = useApi()
  const { questions, answers, step } = rich
  const q = questions[step]
  const answered = answers[step]
  const done = answers.length === questions.length && questions.length > 0
  const score = questions.filter((x, i) => answers[i] === x.answerIndex).length
  const choose = (ci: number) => {
    if (answers.length !== step) return
    api.update(id, { ...rich, answers: [...answers, ci] })
  }
  return (
    <section className={shared.stack} aria-label={t('ai.quiz')}>
      <p className={shared.hint}>{t('ai.quizNoFsrs')}</p>
      {q ? (
        <QuizStep q={q} index={step} total={questions.length} answer={answered} onChoose={choose} />
      ) : (
        <p className={shared.muted}>{rich.empty ? t('chat.nothingToRead') : t('chat.quizEmpty')}</p>
      )}
      {answered !== undefined && step < questions.length - 1 && (
        <div className={shared.row}>
          <Button variant="primary" onClick={() => api.update(id, { ...rich, step: step + 1 })}>
            {t('chat.nextQuestion')}
          </Button>
        </div>
      )}
      {done && (
        <p className={shared.score} role="status">
          {t('ai.score', { score, total: questions.length })}
        </p>
      )}
      <Options id={id} kind="quiz" options={rich.options} />
    </section>
  )
}

/** Questions as they are written. */
export function PartialQuiz({ partial }: { partial: DeepPartial<{ questions: QuizQuestion[] }> | null }) {
  const t = useT()
  const count = (partial?.questions ?? []).filter((q) => q?.question).length
  return (
    <p className={shared.muted} role="status">
      {count > 0 ? t('chat.writingQuestions', { count }) : t('chat.writing')}
    </p>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Study sheet

type Point = { heading?: string; explanation?: string; sourceRef?: Partial<SourceRef> }
type SheetDraftValue = { title?: string; summary?: string; points?: (Point | undefined)[] }

const pointMarkdown = (p: Point | undefined) =>
  [p?.heading?.trim() ? `## ${p.heading.trim()}` : '', p?.explanation?.trim() ?? '']
    .filter((s) => s !== '')
    .join('\n\n')

/** Streamed points arrive in order and never reorder, so their position is their identity. */
function pointKeys(points: readonly (Point | undefined)[]): { p: Point | undefined; key: string }[] {
  return points.map((p, n) => ({ p, key: `point-${n + 1}` }))
}

/** The sheet as a saved study sheet reads it (same Markdown, same renderer), each point with the source it cites. */
export function SheetView({
  sheet,
  busy,
  cite,
}: {
  sheet: SheetDraftValue
  busy: boolean
  cite: (r: Partial<SourceRef> | undefined) => SourceRef | null
}) {
  const t = useT()
  return (
    <article className={shared.card} aria-busy={busy} aria-label={t('ai.fiche')}>
      {sheet.title && <h2 className={shared.title}>{sheet.title}</h2>}
      {sheet.summary?.trim() && <Sanitized markdown={sheet.summary.trim()} />}
      {pointKeys(sheet.points ?? []).map(({ p, key }) => {
        const ref = cite(p?.sourceRef)
        const markdown = pointMarkdown(p)
        if (markdown === '' && !ref) return null
        return (
          <div key={key} className={shared.tight}>
            {markdown !== '' && <Sanitized markdown={markdown} />}
            {ref && <Citation sourceRef={ref} />}
          </div>
        )
      })}
      {busy && <span className={shared.cursor} aria-hidden="true" />}
      {!busy && <p className={shared.hint}>{t('ai.sources')}</p>}
    </article>
  )
}

/** A sheet still being written: a citation shows once it points at a source of the course. */
export function PartialSheet({ partial }: { partial: DeepPartial<Understanding> | null }) {
  const ws = useWorkspace()
  if (!partial) return null
  const cite = (r: Partial<SourceRef> | undefined): SourceRef | null =>
    r?.sourceId && ws.sources.get(r.sourceId) ? { sourceId: r.sourceId, page: r.page } : null
  return <SheetView sheet={partial as SheetDraftValue} busy cite={cite} />
}

/** The sheet as a study sheet's Markdown: its summary, then each point with the source it cites. */
function sheetMarkdown(result: Understanding, titleOf: (ref: SourceRef) => string | null): string {
  const parts = [result.summary.trim()]
  for (const p of result.points) {
    parts.push(`## ${p.heading.trim()}`, p.explanation.trim())
    const cited = p.sourceRef ? titleOf(p.sourceRef) : null
    if (cited) parts.push(`*${cited}*`)
  }
  return parts.filter((s) => s !== '').join('\n\n')
}

function SheetAnswer({ id, rich }: { id: string; rich: Extract<RichResult, { kind: 'sheet' }> }) {
  const t = useT()
  const ws = useWorkspace()
  const api = useApi()
  const { options, value } = rich
  const place = usePlace(options)
  const course = ws.courses.get(options.courseId)
  // Citations were checked against the passages sent; a source removed since shows as removed.
  const cite = (r: Partial<SourceRef> | undefined): SourceRef | null =>
    r?.sourceId ? { sourceId: r.sourceId, ...(r.page === undefined ? {} : { page: r.page }) } : null
  const save = () => {
    if (!course) return
    const refs = value.points.flatMap((p) => (p.sourceRef && ws.sources.get(p.sourceRef.sourceId) ? [p.sourceRef] : []))
    const body = sheetMarkdown(value, (ref) =>
      refs.includes(ref) ? (ws.sources.get(ref.sourceId)?.title ?? null) : null,
    )
    const saved = ws.batch(() => {
      const sheet = ws.fiches.create({
        courseId: course.id,
        ...(options.sectionId ? { sectionId: options.sectionId } : {}),
        title: value.title.trim() || t('ai.fiche'),
        sourceIds: [...new Set(refs.map((r) => r.sourceId))],
      })
      ws.text({ id: sheet, field: 'body' }).insert(0, body)
      return sheet
    })
    api.update(id, { ...rich, savedId: saved })
  }
  // The course opens on its study sheets, where this one now is.
  const sheets: CardNotice = { tab: 'fiches' }
  if (rich.empty) return <NothingToRead id={id} kind="understand" options={options} />
  return (
    <div className={shared.stack}>
      <AskInSheet>
        <SheetView sheet={value} busy={false} cite={cite} />
      </AskInSheet>
      <div className={shared.tight}>
        {course && (
          <div className={shared.row}>
            <Done
              done={rich.savedId !== undefined}
              label={t('ai.saveSheetTo', { place })}
              icon={<NotebookText size={18} strokeWidth={1.75} aria-hidden />}
              onClick={save}
            />
            {rich.savedId !== undefined && (
              <p className={shared.success} role="status">
                {t('ai.sheetSaved', { course: place })}{' '}
                <Link href={to.place(course.id, options.sectionId)} state={sheets}>
                  {t('ai.openSheets')}
                </Link>
              </p>
            )}
          </div>
        )}
      </div>
      <Options id={id} kind="understand" options={options} />
      <ExplainBack
        check={(explanation, onPartial) => api.checkExplanation(options, explanation, onPartial)}
        blocked={api.blocked}
        review={rich.review}
        onReview={(review) => api.update(id, { ...rich, review })}
      />
    </div>
  )
}

/**
 * « Ask about “term” » for a term (or a passage) selected in the sheet, as on a source: asked in this thread, with
 * the line it was selected in.
 */
function AskInSheet({ children }: { children: ReactNode }) {
  const t = useT()
  const chat = useChat()
  const api = useApi()
  const area = useRef<HTMLDivElement>(null)
  const scopeOf = useCallback((el: Element) => (area.current?.contains(el) ? area.current : null), [])
  const { selected, launcher, clear } = useSelectedTerm(scopeOf)
  const ask = () => {
    if (!selected || !chat) return
    const { question, excerpt } = askAbout(t, selected)
    chat.ask(question, excerpt)
    clear()
  }
  return (
    <>
      <div ref={area}>{children}</div>
      {selected && chat && (
        <div ref={launcher} className={shared.row}>
          <Button
            variant="secondary"
            icon={<MessageCircle size={18} strokeWidth={1.75} aria-hidden />}
            disabled={api.blocked}
            onMouseDown={keepSelection}
            onClick={ask}
          >
            {askAbout(t, selected).label}
          </Button>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Answer in one's own words

const GRADE_KEYS = { 1: 'review.again', 2: 'review.hard', 3: 'review.good', 4: 'review.easy' } as const

const RATINGS = [1, 2, 3, 4] as const

/**
 * The grade suggested for the student's answer; until the card's answer shows, nothing here gives it away. While
 * the card is on screen it can be graded from here (the suggested grade first in line), with no need to go back to
 * the card first.
 */
function GradeAnswer({
  id,
  rich,
  revealed,
  onScreen,
}: {
  id: string
  rich: Extract<RichResult, { kind: 'grade' }>
  revealed: boolean
  onScreen: boolean
}) {
  const t = useT()
  const api = useApi()
  const feedback = useMemo(
    () =>
      revealed
        ? rich.feedback
        : (guardAnswer([rich.feedback], answerTerms(rich.card.front, rich.card.back))[0]?.text ?? ''),
    [revealed, rich],
  )
  const give = (rating: 1 | 2 | 3 | 4) => {
    api.update(id, { ...rich, rated: rating })
    api.rate(rich.card, rating)
  }
  return (
    <div className={shared.tight}>
      <p className={shared.heading}>{t('review.suggested', { grade: t(GRADE_KEYS[rich.rating]) })}</p>
      <p className={shared.body}>{feedback}</p>
      {rich.rated !== undefined ? (
        <p className={cx(shared.success, styles.saved)} role="status">
          <Check size={14} aria-hidden="true" />
          <span>{t('chat.graded', { grade: t(GRADE_KEYS[rich.rated]) })}</span>
        </p>
      ) : (
        onScreen && (
          <>
            <fieldset className={styles.grades}>
              <legend className="sr-only">{t('review.gradesLabel')}</legend>
              {RATINGS.map((r) => (
                <Button
                  key={r}
                  variant={r === rich.rating ? 'primary' : 'secondary'}
                  aria-describedby={r === rich.rating ? `${id}-suggested` : undefined}
                  onClick={() => give(r)}
                >
                  {t(GRADE_KEYS[r])}
                </Button>
              ))}
            </fieldset>
            <p id={`${id}-suggested`} className={shared.hint}>
              {t('chat.gradeHint')}
            </p>
          </>
        )
      )}
    </div>
  )
}

/** The feedback as it is written, guarded like the rest before the reveal. */
export function PartialGrade({
  partial,
  card,
}: {
  partial: DeepPartial<{ feedback: string }> | null
  card: { front: string; back: string }
}) {
  const t = useT()
  const text = partial?.feedback
    ? (guardAnswer([partial.feedback], answerTerms(card.front, card.back))[0]?.text ?? '')
    : ''
  return text ? (
    <p className={shared.body} aria-live="off">
      {text} ▍
    </p>
  ) : (
    <p className={shared.muted} role="status">
      {t('review.checking')}
    </p>
  )
}

// ---------------------------------------------------------------------------------------------------------
// A rewrite of a hard card

function ImproveAnswer({
  id,
  rich,
  revealed,
}: {
  id: string
  rich: Extract<RichResult, { kind: 'improve' }>
  revealed: boolean
}) {
  const ws = useWorkspace()
  const api = useApi()
  const exists = useWorkspaceData([{ id: rich.cardId }], (w) => w.cards.get(rich.cardId) !== undefined)
  const apply = () => {
    ws.batch(() => {
      for (const [field, value] of [
        ['front', rich.value.front],
        ['back', rich.value.back],
      ] as const) {
        const text = ws.text({ id: rich.cardId, field })
        text.delete(0, text.length)
        text.insert(0, value)
      }
    })
    api.update(id, { ...rich, applied: true })
  }
  return (
    <Proposal
      value={rich.value}
      applied={rich.applied === true}
      onApply={exists ? apply : undefined}
      hideBack={!revealed}
    />
  )
}

/**
 * A rewrite of the card. Before the card's answer shows on screen, the proposed answer waits folded (it would give
 * the card's answer away), as every other answer of the chat does.
 */
function Proposal({
  value,
  applied,
  onApply,
  busy = false,
  hideBack = false,
}: {
  value: DeepPartial<CardImprovement>
  applied?: boolean
  onApply?: () => void
  busy?: boolean
  hideBack?: boolean
}) {
  const t = useT()
  const titleId = useId()
  const back = value.back !== undefined && (
    <div className={styles.face}>
      <span className={shared.label}>{t('review.answer')}</span>
      <Sanitized markdown={busy && !value.rationale ? `${value.back} ▍` : value.back} />
    </div>
  )
  return (
    <section className={shared.tight} aria-labelledby={titleId} aria-busy={busy || undefined}>
      <h3 id={titleId} className={shared.heading}>
        {t('review.improveTitle')}
      </h3>
      <div className={styles.face}>
        <span className={shared.label}>{t('review.question')}</span>
        <Sanitized markdown={busy && !value.back ? `${value.front ?? ''} ▍` : (value.front ?? '')} />
      </div>
      {back &&
        (hideBack ? (
          <details className={shared.disclosure}>
            <summary className={shared.disclosureSummary}>
              <span className={shared.disclosureLabel}>{t('chat.showProposedAnswer')}</span>
              <ChevronDown size={18} aria-hidden="true" className={shared.chevron} />
            </summary>
            <div className={shared.disclosureBody}>{back}</div>
          </details>
        ) : (
          back
        ))}
      {value.rationale && <p className={shared.muted}>{value.rationale}</p>}
      {onApply && (
        <div className={shared.row}>
          <Done done={applied === true} label={t('review.applyImprovement')} onClick={onApply} />
          {applied && (
            <p className={shared.success} role="status">
              {t('review.improved')}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

export function PartialImprove({
  partial,
  hideBack = false,
}: {
  partial: DeepPartial<CardImprovement> | null
  hideBack?: boolean
}) {
  const t = useT()
  if (!partial?.front) {
    return (
      <p className={shared.muted} role="status">
        {t('review.improving')}
      </p>
    )
  }
  return <Proposal value={partial} busy hideBack={hideBack} />
}

/**
 * The action that saved or applied an answer, once done: it stays (the same control, disabled) but steps back to a
 * quiet, ticked state beside the line that says it is done, instead of a faded primary button still asking.
 */
function Done({ done, label, icon, onClick }: { done: boolean; label: string; icon?: ReactNode; onClick: () => void }) {
  return (
    <Button
      variant={done ? 'plain' : 'primary'}
      icon={done ? <Check size={18} strokeWidth={1.75} aria-hidden /> : icon}
      className={done ? styles.done : undefined}
      disabled={done}
      onClick={onClick}
    >
      {label}
    </Button>
  )
}

// ---------------------------------------------------------------------------------------------------------
// A photo

function Reading({ description }: { description: DeepPartial<PhotoDescription> }) {
  const t = useT()
  const points = (description.keyPoints ?? []).filter((k): k is string => typeof k === 'string' && k !== '')
  return (
    <>
      {description.title && <h3 className={shared.heading}>{description.title}</h3>}
      <Section title={t('photos.aiTranscription')}>
        {description.transcription ? (
          <div className={styles.transcription}>
            <Sanitized markdown={description.transcription} />
          </div>
        ) : (
          <p className={shared.hint}>{t('photos.aiNoText')}</p>
        )}
      </Section>
      {description.explanation && (
        <Section title={t('photos.aiExplanation')}>
          <p className={shared.body}>{description.explanation}</p>
        </Section>
      )}
      {points.length > 0 && (
        <Section title={t('photos.aiKeyPoints')}>
          <ul className={shared.bullets}>
            {keyedChoices(points).map(({ item, key }) => (
              <li key={key}>{item}</li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

export function PartialPhoto({ partial }: { partial: DeepPartial<PhotoDescription> | null }) {
  const t = useT()
  return (
    <div className={shared.stack}>
      <p className={shared.muted} role="status">
        {t('photos.aiReading')}
      </p>
      {partial?.title && (
        <div className={shared.stack} aria-busy="true">
          <Reading description={partial} />
        </div>
      )}
    </div>
  )
}

const PHOTO_COUNTS = ['5', '10', '20'] as const

/**
 * What a model read on a photo, kept on this device for study sheets to cite, with « Explain again », a study
 * sheet from the photo's place, and cards from it (and any other photo of the course, in one request).
 */
function PhotoAnswer({ rich }: { rich: Extract<RichResult, { kind: 'photo' }> }) {
  const t = useT()
  const api = useApi()
  const ws = useWorkspace()
  const cost = useCost()
  const photo = getPhoto(ws, rich.photoId)
  const writeSheet = () => {
    const place = photo?.sectionId
      ? { courseId: rich.courseId, sectionId: photo.sectionId }
      : { courseId: rich.courseId }
    api.start('understand', {
      ...place,
      sourceIds: ws.scoped('sources', place).map((s) => s.id),
      pasted: '',
      topic: rich.description.title,
      count: 10,
      detail: 'standard',
    })
  }
  return (
    <div className={shared.stack}>
      <div className={shared.stack}>
        <Reading description={rich.description} />
      </div>
      <p className={shared.hint}>{t('photos.aiCiteable')}</p>
      <div className={shared.row}>
        <Button variant="secondary" disabled={api.blocked} onClick={writeSheet}>
          {t('ai.writeSheet')}
        </Button>
      </div>
      {/* Reading the photo again has its own cost, said beside it. */}
      <div className={shared.tight}>
        <div className={shared.row}>
          <Button variant="plain" disabled={api.blocked} onClick={() => api.explainPhoto(rich.photoId)}>
            {t('photos.aiExplainAgain')}
          </Button>
          <span className={shared.hint}>{cost(api.ai, photoCost(api.ai))}</span>
        </div>
        <p className={shared.hint}>{t('photos.aiReduced', { size: 1024 })}</p>
      </div>
      <PhotoCards courseId={rich.courseId} photoId={rich.photoId} />
    </div>
  )
}

function PhotoCards({ courseId, photoId }: { courseId: string; photoId: string }) {
  const t = useT()
  const api = useApi()
  const cost = useCost()
  const photos = useWorkspaceData(['sources', 'sections', { id: courseId }], (w) => listPhotos(w, { courseId }))
  const others = useMemo(() => photos.filter((p) => p.id !== photoId), [photos, photoId])
  const [chosen, setChosen] = useState<string[]>([photoId])
  const [count, setCount] = useState<(typeof PHOTO_COUNTS)[number]>('10')
  // Photos trashed meanwhile drop out of the choice.
  const picked = chosen.filter((id) => id === photoId || others.some((p) => p.id === id))
  return (
    <section className={shared.stack} aria-labelledby={`${photoId}-cards`}>
      <h3 id={`${photoId}-cards`} className={shared.label}>
        {t('photos.aiCards')}
      </h3>
      {others.length > 0 && <PhotoChoice photoId={photoId} others={others} chosen={picked} onChange={setChosen} />}
      <Segmented
        label={t('ai.cardCount')}
        value={count}
        onChange={setCount}
        options={PHOTO_COUNTS.map((c) => ({ value: c, label: c }))}
      />
      <div className={shared.row}>
        <Button
          variant="primary"
          disabled={api.blocked}
          onClick={() => api.photoCards(courseId, picked, Number(count))}
        >
          {t('photos.aiDraft')}
        </Button>
        <span className={shared.hint}>{cost(api.ai, photoCardsCost(api.ai, picked.length, Number(count)))}</span>
      </div>
    </section>
  )
}

/** This photo, plus any other photo of the course to draft from in the same request. */
function PhotoChoice({
  photoId,
  others,
  chosen,
  onChange,
}: {
  photoId: string
  others: readonly Photo[]
  chosen: readonly string[]
  onChange: (ids: string[]) => void
}) {
  const t = useT()
  const toggle = (id: string, on: boolean) => onChange(on ? [...chosen, id] : chosen.filter((x) => x !== id))
  const thumbs = useThumbs(others.map((p) => p.blobId))
  return (
    <fieldset className={shared.fieldset}>
      <legend className={shared.label}>{t('photos.aiPhotos')}</legend>
      <ul className={shared.checks}>
        <li>
          <label className={shared.check}>
            <input type="checkbox" checked disabled />
            <span>{t('photos.aiThisPhoto')}</span>
          </label>
        </li>
        {others.map((p) => {
          const thumb = thumbs.get(p.blobId)
          return (
            <li key={p.id}>
              <label className={shared.check}>
                <input
                  type="checkbox"
                  checked={chosen.includes(p.id)}
                  onChange={(e) => toggle(p.id, e.target.checked)}
                />
                {thumb?.kind === 'ready' ? (
                  <img className={styles.thumb} src={thumb.url} alt="" data-rotation={p.rotation} />
                ) : (
                  <span className={styles.thumb} aria-hidden="true" />
                )}
                <span>{photoLabel(p)}</span>
              </label>
            </li>
          )
        })}
      </ul>
      {chosen.length > 1 && chosen.includes(photoId) && (
        <p className={shared.hint}>{t('photos.aiPhotosHint', { count: chosen.length })}</p>
      )}
    </fieldset>
  )
}

/** The photo a question was asked about, attached to the student's turn. */
export function AttachedPhoto({ photoId }: { photoId: string }) {
  const t = useT()
  const ws = useWorkspace()
  const photo = getPhoto(ws, photoId)
  const thumb = useThumbs(photo ? [photo.blobId] : []).get(photo?.blobId ?? '')
  if (!photo) return null
  const name = photoLabel(photo)
  return (
    <Link href={to.photo(photo.id)} className={styles.attached} aria-label={t('photos.aiOpenPhoto', { name })}>
      {thumb?.kind === 'ready' ? (
        <img className={styles.attachedImage} src={thumb.url} alt="" data-rotation={photo.rotation} />
      ) : (
        <span className={styles.attachedImage} aria-hidden="true" />
      )}
    </Link>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Cards proposed on a source by the background queue

/**
 * Where the cards proposed on a source stand: the queue's progress (with its cost cap and retry), then how many
 * wait in « Suggested cards ». For slides or a document, the slides or sections can also be picked by hand.
 */
function JobAnswer({ sourceId }: { sourceId: string }) {
  const t = useT()
  const rt = useRuntime()
  const queue = useAutoJobs(rt)
  const source = useWorkspaceData([{ id: sourceId }], (w) => w.sources.get(sourceId))
  const waiting = useWorkspaceData(
    ['drafts', 'sources', 'courses', 'sections'],
    (w) => w.drafts.list({ sourceId }).length,
  )
  const job = jobOf(queue.jobs, sourceId)
  const q = liveQueue()
  const act =
    (what: string, fn: (id: string) => Promise<void>) =>
    (id: string): void => {
      fn(id).catch((e: unknown) => noteError(`chat.${what}`, e))
    }
  const actions = q
    ? {
        cancel: act('cancel', (id) => q.cancel(id)),
        retry: act('retry', (id) => q.retry(id)),
      }
    : undefined
  return (
    <div className={shared.tight} data-testid="chat-job">
      {source && <p className={shared.heading}>{source.title}</p>}
      {!job ? (
        <p className={shared.muted}>{t('ai.inboxQueued')}</p>
      ) : (
        // In the thread that started it, a cancel is said too.
        (isActiveJob(job) || job.status === 'cancelled' || jobWorthShowing(job, waiting > 0, Date.now())) && (
          <JobLine job={job} actions={actions} />
        )
      )}
      {(!job || !isActiveJob(job)) && waiting > 0 && (
        <p className={shared.body}>{t('chat.jobWaiting', { count: waiting })}</p>
      )}
      <div className={shared.row}>
        <Link href={paths.inbox} className={styles.link}>
          {t('chat.openSuggested')}
        </Link>
        {source?.support !== undefined && (
          <Link href={to.deckQuestions(sourceId)} className={styles.link}>
            {t('chat.pickUnits')}
          </Link>
        )}
      </div>
    </div>
  )
}

/** An action that found nothing to read: nothing was asked; its options say where to look, then it runs again. */
function NothingToRead({ id, kind, options }: { id: string; kind: StudyKind; options: StudyOptions }) {
  const t = useT()
  return (
    <div className={shared.stack}>
      <p className={shared.muted}>{t('chat.nothingToRead')}</p>
      <Options id={id} kind={kind} options={options} />
    </div>
  )
}
