import { MessageCircle, Plus } from 'lucide-react'
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'wouter'
import { to } from '../app/routes.ts'
import { useRuntime, useWorkspace, useWorkspaceData } from '../app/workspaceContext.tsx'
import type { FeatureCtx } from '../core/ai/client'
import { type ExplainLevel, explainConcept } from '../core/ai/features/explainConcept'
import {
  type AnswerTerms,
  answerTerms,
  EXPLAIN_OUTPUT_TOKENS,
  explainQuestion,
  foldWord,
  type GuardedText,
  guardAnswer,
  type QuestionExplanation,
} from '../core/ai/features/explainQuestion'
import type { Chunk } from '../core/ai/retrieval'
import type { SourceRef } from '../core/ai/schemas'
import { blobStore } from '../core/log/blobs'
import { formatUsd } from '../i18n/format.ts'
import { useLocale, useT } from '../i18n/react.tsx'
import { describeFailure } from '../screens/Review/failure.ts'
import type { AiModelState } from '../screens/Understand/shared/aiConfig.ts'
import { citationText, useCitedUnit } from '../screens/Understand/shared/citations.ts'
import { chunksFor, deckReader, estimateCost, PASTED } from '../screens/Understand/shared/sources.ts'
import { useChat } from './chat/context.tsx'
import { Button } from './components/Button.tsx'
import { Field } from './components/Field.tsx'
import { Segmented } from './components/Segmented.tsx'
import { Sheet } from './components/Sheet.tsx'
import { cx } from './cx.ts'
import { useCanCallAi } from './ExplainLauncher.tsx'
import styles from './ExplainSheet.module.css'

/** What the sheet is asked to explain: the card's question, or a concept (a selected or typed term). */
export type ExplainRequest = { kind: 'question' } | { kind: 'concept'; term: string; context?: string }
/** A request as launched; a new `seq` is a new launch, even of the same request. */
export type ExplainTarget = ExplainRequest & { seq: number }

export interface ExplainSheetProps {
  open: boolean
  onClose: () => void
  ai: Extract<AiModelState, { status: 'ready' }>
  target: ExplainTarget
  /** Course whose sources ground the explanation, and where a card on the concept goes. */
  courseId?: string
  sectionId?: string
  /**
   * In review, the card on screen. Until `revealed`, nothing the sheet shows may give its answer away:
   * guarded fields show redacted with « Show anyway », and citations are links without their passage.
   */
  card?: { front: string; back: string }
  revealed?: boolean
}

type Call<T> =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'done'; value: T }
  | { status: 'failed'; message: string }

interface ConceptResult {
  term: string
  level: ExplainLevel
  definition: GuardedText
  explanation: GuardedText
  example: GuardedText
  related: GuardedText[]
  citations: SourceRef[]
  card: { front: string; back: string }
}

const IDLE = { status: 'idle' } as const
const clean = (text: string): GuardedText => ({ text, leaked: false })
const settle = <T,>(c: Call<T>): Call<T> => (c.status === 'busy' ? IDLE : c)
const shownText = (g: GuardedText, open: boolean) => (open ? (g.original ?? g.text) : g.text)

/** The explanation sheet: « Explain the question » in review, « Explain “term” » anywhere. Loaded on demand. */
export default function ExplainSheet({
  open,
  onClose,
  ai,
  target,
  courseId,
  sectionId,
  card,
  revealed = true,
}: ExplainSheetProps) {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const ws = useWorkspace()
  // Online, or a model on this device: it explains without a connection.
  const online = useCanCallAi(ai)
  const region = useRef<HTMLDivElement>(null)
  const abort = useRef<AbortController | null>(null)
  const chunks = useRef<Promise<Chunk[]> | null>(null)
  const ran = useRef<number | null>(null)
  const [grounding, setGrounding] = useState<Chunk[]>([])
  const [estimate, setEstimate] = useState<number | null>(null)
  const [question, setQuestion] = useState<Call<QuestionExplanation>>(IDLE)
  const [concept, setConcept] = useState<Call<ConceptResult>>(IDLE)
  const [asked, setAsked] = useState('')
  const [term, setTerm] = useState(target.kind === 'concept' ? target.term : '')
  const [level, setLevel] = useState<ExplainLevel>('standard')
  const [seen, setSeen] = useState(target.seq)
  if (seen !== target.seq) {
    setSeen(target.seq)
    if (target.kind === 'concept') setTerm(target.term)
  }

  useEffect(() => () => abort.current?.abort(), [])

  // The course's passages, read once: they ground every request and price the estimate.
  const loadChunks = useCallback((): Promise<Chunk[]> => {
    if (chunks.current === null) {
      const ids = courseId ? ws.sources.list({ courseId }).map((s) => s.id) : []
      const loading = chunksFor(ws, blobStore(rt.store), ids, '', deckReader(rt))
      chunks.current = loading
      // A failed read is retried by the next request, which reports it.
      loading.catch(() => {
        if (chunks.current === loading) chunks.current = null
      })
    }
    return chunks.current
  }, [courseId, ws, rt])

  useEffect(() => {
    if (!open) return
    let live = true
    loadChunks().then(
      (loaded) => {
        if (!live) return
        setGrounding(loaded)
        setEstimate(estimateCost(ai.info, loaded, EXPLAIN_OUTPUT_TOKENS))
      },
      (error: unknown) => {
        if (live) console.warn('Course passages could not be read for the estimate', error)
      },
    )
    return () => {
      live = false
    }
  }, [open, loadChunks, ai])

  const start = useCallback(
    async <T,>(
      set: (c: Call<T>) => void,
      fn: (ctx: FeatureCtx, chunks: Chunk[], courseTitle: string | undefined) => Promise<T>,
    ) => {
      // One request at a time: a new one replaces whatever was running.
      abort.current?.abort()
      setQuestion(settle)
      setConcept(settle)
      const controller = new AbortController()
      abort.current = controller
      set({ status: 'busy' })
      try {
        const loaded = await loadChunks()
        const course = courseId ? ws.courses.get(courseId) : undefined
        const ctx = await ai.context(controller.signal, course?.language)
        const value = await fn(ctx, loaded, course?.title)
        if (controller.signal.aborted) return
        set({ status: 'done', value })
      } catch (error) {
        // Cancelled: `cancel` already settled the state.
        if (controller.signal.aborted) return
        console.warn('Explanation request failed', error)
        set({ status: 'failed', message: describeFailure(error, t) })
      }
    },
    [loadChunks, courseId, ws, ai, t],
  )

  const runQuestion = useCallback(() => {
    if (!card) return
    void start<QuestionExplanation>(setQuestion, (ctx, loaded, courseTitle) =>
      explainQuestion(ctx, { card, revealed, chunks: loaded, courseTitle }),
    )
  }, [card, revealed, start])

  const runConcept = useCallback(
    (raw: string, context: string | undefined, lvl: ExplainLevel) => {
      const term = raw.trim()
      if (term === '') return
      setAsked(term)
      void start<ConceptResult>(setConcept, async (ctx, loaded, courseTitle) => {
        const out = await explainConcept(ctx, { term, context, level: lvl, chunks: loaded, courseTitle })
        const fields = [out.definition, out.explanation, out.example, ...out.relatedConcepts]
        // In review the concept is checked against the card like the question is: what would give the
        // answer away stays hidden until the reveal.
        const guarded = card ? guardAnswer(fields, answerTerms(card.front, card.back)) : fields.map(clean)
        const at = (i: number) => guarded[i] ?? clean('')
        return {
          term,
          level: lvl,
          definition: at(0),
          explanation: at(1),
          example: at(2),
          related: guarded.slice(3),
          citations: out.citations,
          card: out.suggestedCard,
        }
      })
    },
    [card, start],
  )

  // Each launch runs once, when the sheet is open and online; a question already explained is shown again.
  useEffect(() => {
    if (!open || ran.current === target.seq) return
    ran.current = target.seq
    if (!online) return
    if (target.kind === 'question') {
      if (question.status === 'idle' || question.status === 'failed') runQuestion()
      return
    }
    const same = concept.status === 'done' && concept.value.term === target.term.trim() && concept.value.level === level
    if (!same) runConcept(target.term, target.context, level)
  }, [open, target, online, question.status, concept, level, runQuestion, runConcept])

  const cancel = () => {
    abort.current?.abort()
    setQuestion(settle)
    setConcept(settle)
  }

  const guard = useAnswerGuard(card, revealed)
  const chat = useChat()
  // What was shown, as the chat opens on it: guarded fields as they appear.
  const shown =
    target.kind === 'question'
      ? question.status === 'done'
        ? [question.value.restatement.text, question.value.context.text]
        : []
      : concept.status === 'done'
        ? [concept.value.term, concept.value.definition.text, concept.value.explanation.text]
        : []
  const followUp = () => {
    chat?.followUp(shown.filter((s) => s.trim() !== '').join('\n\n'))
    onClose()
  }
  const cost = estimate === null ? null : `${t('ai.cost', { amount: formatUsd(locale, estimate) })} · ${ai.info.name}`

  const title =
    target.kind === 'question'
      ? t('ai.explainQuestion')
      : asked
        ? t('ai.explainTerm', { term: asked })
        : t('ai.explainConcept')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (target.kind === 'concept') runConcept(term, target.context, level)
  }

  return (
    <Sheet
      open={open}
      title={title}
      onClose={onClose}
      initialFocus={target.kind === 'concept' && target.term.trim() === '' ? undefined : region}
    >
      {target.kind === 'concept' && (
        <form className={styles.form} onSubmit={submit}>
          <Field
            label={t('ai.conceptLabel')}
            value={term}
            placeholder={t('ai.conceptPlaceholder')}
            enterKeyHint="go"
            onChange={(e) => setTerm(e.target.value)}
          />
          <Segmented<ExplainLevel>
            label={t('ai.level')}
            value={level}
            onChange={setLevel}
            options={[
              { value: 'simple', label: t('ai.levelBasics') },
              { value: 'standard', label: t('ai.levelStandard') },
              { value: 'advanced', label: t('ai.levelDeep') },
            ]}
          />
          <div className={styles.row}>
            <Button
              type="submit"
              variant={concept.status === 'done' ? 'secondary' : 'primary'}
              disabled={term.trim() === '' || !online || concept.status === 'busy'}
            >
              {t('ai.explain')}
            </Button>
            {cost && <span className={styles.hint}>{cost}</span>}
          </div>
        </form>
      )}
      <div ref={region} tabIndex={-1} className={styles.region} aria-busy={question.status === 'busy' || undefined}>
        {!online && <p className={styles.note}>{t('ai.explainOffline')}</p>}
        {target.kind === 'question' ? (
          <Outcome call={question} onCancel={cancel}>
            {(value) => (
              <QuestionView
                value={value}
                revealed={revealed}
                chunks={grounding}
                query={card?.front ?? ''}
                guard={guard}
              />
            )}
          </Outcome>
        ) : (
          <Outcome call={concept} onCancel={cancel}>
            {(value) => (
              <ConceptView
                key={`${value.term}/${value.level}`}
                value={value}
                revealed={revealed}
                chunks={grounding}
                guard={guard}
                courseId={courseId}
                sectionId={sectionId}
                online={online}
                onExplain={(next) => {
                  setTerm(next)
                  runConcept(next, undefined, level)
                }}
              />
            )}
          </Outcome>
        )}
        {target.kind === 'question' && question.status !== 'busy' && question.status !== 'done' && (
          <div className={styles.row}>
            <Button variant="primary" disabled={!online} onClick={runQuestion}>
              {question.status === 'failed' ? t('common.retry') : t('ai.explainQuestion')}
            </Button>
          </div>
        )}
        {target.kind === 'question' && cost && <p className={styles.hint}>{cost}</p>}
        {chat && shown.length > 0 && (
          <div className={styles.row}>
            <Button
              variant="secondary"
              icon={<MessageCircle size={18} strokeWidth={1.75} aria-hidden />}
              onClick={followUp}
            >
              {t('chat.followUp')}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  )
}

/** Redacts answer terms in other text shown before the reveal (a source title, say). */
function useAnswerGuard(card: { front: string; back: string } | undefined, revealed: boolean) {
  const [terms] = useState<AnswerTerms | null>(() => (card ? answerTerms(card.front, card.back) : null))
  return useCallback(
    (text: string): string => (terms && !revealed ? (guardAnswer([text], terms)[0]?.text ?? text) : text),
    [terms, revealed],
  )
}

function Outcome<T>({
  call,
  onCancel,
  children,
}: {
  call: Call<T>
  onCancel: () => void
  children: (value: T) => ReactNode
}) {
  const t = useT()
  if (call.status === 'busy') {
    return (
      <div className={styles.busy}>
        <span className={styles.spinner} aria-hidden="true" />
        <p role="status">{t('ai.explaining')}</p>
        <Button variant="plain" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    )
  }
  if (call.status === 'failed') {
    return (
      <p className={styles.error} role="alert">
        {call.message}
      </p>
    )
  }
  if (call.status === 'done') return <>{children(call.value)}</>
  return null
}

/** A field that may give the answer away: redacted before the reveal, with « Show anyway ». */
function Guarded({
  value,
  revealed,
  className = styles.body,
}: {
  value: GuardedText
  revealed: boolean
  className?: string
}) {
  const t = useT()
  const [shown, setShown] = useState(false)
  const text = useRef<HTMLParagraphElement>(null)
  const open = revealed || shown || !value.leaked
  const display = shownText(value, open)
  useEffect(() => {
    if (shown) text.current?.focus()
  }, [shown])
  if (display.trim() === '') return null
  return (
    <>
      <p ref={text} className={className} tabIndex={shown ? -1 : undefined}>
        {display}
      </p>
      {!open && (
        <p className={styles.hidden}>
          <span>{t('ai.explainHidden')}</span>{' '}
          <button type="button" className={styles.showAnyway} onClick={() => setShown(true)}>
            {t('ai.showAnyway')}
          </button>
        </p>
      )}
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.heading}>
        {title}
      </h3>
      {children}
    </section>
  )
}

function QuestionView({
  value,
  revealed,
  chunks,
  query,
  guard,
}: {
  value: QuestionExplanation
  revealed: boolean
  chunks: readonly Chunk[]
  query: string
  guard: (text: string) => string
}) {
  const t = useT()
  return (
    <>
      <Section title={t('ai.explainAsked')}>
        <Guarded value={value.restatement} revealed={revealed} />
      </Section>
      {value.terms.length > 0 && (
        <Section title={t('ai.explainTerms')}>
          <dl className={styles.terms}>
            {keyed(value.terms, (term) => term.term.original ?? term.term.text).map(({ item: term, key }) => (
              <div key={key} className={styles.term}>
                <dt>
                  <Guarded value={term.term} revealed={revealed} className={styles.termName} />
                </dt>
                <dd className={styles.definition}>
                  <Guarded value={term.definition} revealed={revealed} />
                  {term.sourceRef && <SourceLink sourceRef={term.sourceRef} guard={guard} />}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
      {(value.context.original ?? value.context.text).trim() !== '' && (
        <Section title={t('ai.explainContext')}>
          <Guarded value={value.context} revealed={revealed} />
        </Section>
      )}
      <Citations refs={value.citations} revealed={revealed} chunks={chunks} query={query} guard={guard} />
    </>
  )
}

/** Items with a React key from their content, repeats told apart by their rank among equals. */
function keyed<T>(items: readonly T[], keyOf: (item: T) => string): { item: T; key: string }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = keyOf(item)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return { item, key: n === 1 ? base : `${base}#${n}` }
  })
}

function ConceptView({
  value,
  revealed,
  chunks,
  guard,
  courseId,
  sectionId,
  online,
  onExplain,
}: {
  value: ConceptResult
  revealed: boolean
  chunks: readonly Chunk[]
  guard: (text: string) => string
  courseId?: string
  sectionId?: string
  online: boolean
  onExplain: (term: string) => void
}) {
  const t = useT()
  const ws = useWorkspace()
  const [created, setCreated] = useState(false)
  const courseTitle = useWorkspaceData(['courses', { id: courseId ?? '' }], (w) =>
    courseId ? (w.courses.get(courseId)?.title ?? '') : '',
  )

  const createCard = () => {
    if (!courseId) return
    ws.batch(() => {
      const id = ws.cards.create({ courseId, ...(sectionId ? { sectionId } : {}), kind: 'basic', origin: 'ai' })
      ws.text({ id, field: 'front' }).insert(0, value.card.front)
      ws.text({ id, field: 'back' }).insert(0, value.card.back)
    })
    setCreated(true)
  }

  return (
    <>
      <Guarded value={value.definition} revealed={revealed} className={styles.lead} />
      <Guarded value={value.explanation} revealed={revealed} />
      {(value.example.original ?? value.example.text).trim() !== '' && (
        <Section title={t('ai.explainExample')}>
          <Guarded value={value.example} revealed={revealed} />
        </Section>
      )}
      {value.related.length > 0 && (
        <Section title={t('ai.explainRelated')}>
          <Related items={value.related} revealed={revealed} online={online} onExplain={onExplain} />
        </Section>
      )}
      <Citations refs={value.citations} revealed={revealed} chunks={chunks} query={value.term} guard={guard} />
      {courseId && (
        <div className={styles.create}>
          <Button
            variant="secondary"
            icon={<Plus size={18} strokeWidth={1.75} aria-hidden />}
            disabled={created}
            onClick={createCard}
          >
            {t('ai.createConceptCard')}
          </Button>
          {created && (
            <p className={styles.success} role="status">
              {t('ai.conceptCardCreated', { course: courseTitle })}
            </p>
          )}
        </div>
      )}
    </>
  )
}

/** Neighbouring concepts, each explained in turn on a tap; one that names the answer waits for the reveal. */
function Related({
  items,
  revealed,
  online,
  onExplain,
}: {
  items: GuardedText[]
  revealed: boolean
  online: boolean
  onExplain: (term: string) => void
}) {
  const t = useT()
  const [shown, setShown] = useState(false)
  const open = revealed || shown
  const hiding = !open && items.some((r) => r.leaked)
  return (
    <>
      <ul className={styles.related}>
        {keyed(items, (r) => r.original ?? r.text).map(({ item: r, key }) => {
          const visible = open || !r.leaked
          const term = shownText(r, visible)
          return (
            <li key={key}>
              {visible ? (
                <button
                  type="button"
                  className={styles.chip}
                  disabled={!online}
                  aria-label={t('ai.explainTerm', { term })}
                  onClick={() => onExplain(term)}
                >
                  {term}
                </button>
              ) : (
                <span className={cx(styles.chip, styles.chipHidden)}>{term}</span>
              )}
            </li>
          )
        })}
      </ul>
      {hiding && (
        <p className={styles.hidden}>
          <span>{t('ai.explainHidden')}</span>{' '}
          <button type="button" className={styles.showAnyway} onClick={() => setShown(true)}>
            {t('ai.showAnyway')}
          </button>
        </p>
      )}
    </>
  )
}

const EXCERPT_CHARS = 280

/** The cited passage: of the cited source (and page), the one sharing most words with `query`. */
function passageOf(chunks: readonly Chunk[], ref: SourceRef, query: string): string | null {
  const words = new Set(
    foldWord(query)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  )
  let best: Chunk | null = null
  let bestScore = -1
  for (const c of chunks) {
    if (c.sourceId !== ref.sourceId || (ref.page !== undefined && c.page !== ref.page)) continue
    const text = foldWord(c.text)
    let score = 0
    for (const w of words) if (text.includes(w)) score++
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  if (best === null) return null
  const text = best.text.replace(/\s+/g, ' ').trim()
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : text
}

/** Citations: before the reveal only links to the cited passages, after it the passages too. */
function Citations({
  refs,
  revealed,
  chunks,
  query,
  guard,
}: {
  refs: readonly SourceRef[]
  revealed: boolean
  chunks: readonly Chunk[]
  query: string
  guard: (text: string) => string
}) {
  const t = useT()
  if (refs.length === 0) return <p className={styles.hint}>{t('ai.explainUngrounded')}</p>
  return (
    <Section title={t('ai.explainFromCourse')}>
      <ul className={styles.citations}>
        {refs.map((ref) => {
          const passage = revealed ? passageOf(chunks, ref, query) : null
          return (
            <li key={`${ref.sourceId}/${ref.page ?? ''}`} className={styles.citation}>
              <SourceLink sourceRef={ref} guard={guard} />
              {passage && <blockquote className={styles.passage}>{passage}</blockquote>}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/** A link to a cited source (at its page); its title is guarded like the rest before the reveal. */
function SourceLink({ sourceRef, guard }: { sourceRef: SourceRef; guard: (text: string) => string }) {
  const t = useT()
  const source = useWorkspaceData([{ id: sourceRef.sourceId }], (w) => w.sources.get(sourceRef.sourceId))
  const unit = useCitedUnit(source, sourceRef.page)
  const name =
    sourceRef.sourceId === PASTED ? t('ai.pastedSource') : guard(source?.title ?? '') || t('ai.unknownSource')
  const label = citationText(t, name, source, sourceRef.page, unit)
  if (!source || source.deletedAt !== undefined) return <span className={styles.cite}>{label}</span>
  const href = sourceRef.page === undefined ? to.source(source.id) : `${to.source(source.id)}?page=${sourceRef.page}`
  return (
    <Link href={href} className={styles.cite} aria-label={t('ai.openCitation', { source: label })}>
      {label}
    </Link>
  )
}
