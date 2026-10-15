import { MessageCircle, Plus } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'wouter'
import { to } from '../app/routes.ts'
import { useRuntime, useWorkspace, useWorkspaceData } from '../app/workspaceContext.tsx'
import { type AnswerExplanation, explainCard } from '../core/ai/features/explainCard'
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
import type { CardExplanation, QuestionExplanationDraft, SourceRef } from '../core/ai/schemas'
import { blobStore } from '../core/log/blobs'
import { formatUsd } from '../i18n/format.ts'
import { useLocale, useT } from '../i18n/react.tsx'
import { describeFailure } from '../screens/Review/failure.ts'
import type { AiModelState } from '../screens/Understand/shared/aiConfig.ts'
import { citationText, useCitedUnit } from '../screens/Understand/shared/citations.ts'
import { chunksFor, deckReader, estimateCost, PASTED } from '../screens/Understand/shared/sources.ts'
import { useChat } from './chat/context.tsx'
import { Button } from './components/Button.tsx'
import { Sheet } from './components/Sheet.tsx'
import { usePartial } from './data/usePartial.ts'
import { useCanCallAi } from './ExplainLauncher.tsx'
import styles from './ExplainSheet.module.css'
import { Sanitized } from './render/Sanitized.tsx'

/** What the sheet explains: the card's question, or (once it shows) why the answer is what it is. */
export type ExplainKind = 'question' | 'answer'

/** A launch of the sheet; a new `seq` is a new launch. */
export interface ExplainTarget {
  kind: ExplainKind
  seq: number
}

export interface ExplainSheetProps {
  open: boolean
  onClose: () => void
  ai: Extract<AiModelState, { status: 'ready' }>
  target: ExplainTarget
  /** Course whose sources ground the explanation, and where a card on it goes. */
  courseId?: string
  /**
   * The card on screen. Until `revealed`, nothing the sheet shows may give its answer away: guarded fields
   * show redacted with « Show anyway », and citations are links without their passage.
   */
  card: { front: string; back: string }
  revealed?: boolean
}

type Call<T> =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'done'; value: T }
  | { status: 'failed'; message: string }

const IDLE = { status: 'idle' } as const
const shownText = (g: GuardedText, open: boolean) => (open ? (g.original ?? g.text) : g.text)

/**
 * The two explanations of review, alike: « Explain the question » (what is asked, its terms, its context in the
 * course, never giving the answer away before the reveal) and « Why? » once the answer shows (why it is the
 * answer, an example or a mnemonic, a card on it). Both are grounded in and cited from the course's sources,
 * written as they come; anything broader goes to the chat (« Ask a follow-up »). Loaded on demand.
 */
export default function ExplainSheet({
  open,
  onClose,
  ai,
  target,
  courseId,
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
  const [answer, setAnswer] = useState<Call<AnswerExplanation>>(IDLE)
  const questionStream = usePartial<QuestionExplanationDraft>()
  const answerStream = usePartial<CardExplanation>()
  const kind = target.kind

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

  const run = useCallback(
    async (which: ExplainKind) => {
      // One request at a time: a new one replaces whatever was running.
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      const stream = which === 'question' ? questionStream : answerStream
      const set = which === 'question' ? setQuestion : setAnswer
      stream.reset()
      set({ status: 'busy' })
      try {
        const loaded = await loadChunks()
        const course = courseId ? ws.courses.get(courseId) : undefined
        const ctx = { ...(await ai.context(controller.signal, course?.language)), onPartial: stream.onPartial }
        const input = { chunks: loaded, courseTitle: course?.title }
        if (which === 'question') {
          const value = await explainQuestion(ctx, { card, revealed, ...input })
          if (controller.signal.aborted) return
          setQuestion({ status: 'done', value })
        } else {
          const value = await explainCard(ctx, { front: card.front, back: card.back, ...input })
          if (controller.signal.aborted) return
          setAnswer({ status: 'done', value })
        }
        stream.reset()
      } catch (error) {
        // Cancelled: `cancel` already settled the state.
        if (controller.signal.aborted) return
        stream.reset()
        console.warn('Explanation request failed', error)
        set({ status: 'failed', message: describeFailure(error, t) })
      }
    },
    [loadChunks, courseId, ws, ai, card, revealed, t, questionStream, answerStream],
  )

  // Each launch runs once, when the sheet is open and online; an explanation already given is shown again.
  const current = kind === 'question' ? question : answer
  useEffect(() => {
    if (!open || ran.current === target.seq) return
    ran.current = target.seq
    if (!online) return
    if (current.status === 'idle' || current.status === 'failed') void run(target.kind)
  }, [open, target, online, current.status, run])

  const cancel = () => {
    abort.current?.abort()
    questionStream.reset()
    answerStream.reset()
    if (kind === 'question') setQuestion(IDLE)
    else setAnswer(IDLE)
  }

  const guard = useAnswerGuard(card, revealed)
  const chat = useChat()
  // What was shown, as the chat opens on it: guarded fields as they appear.
  const shown =
    kind === 'question'
      ? question.status === 'done'
        ? [question.value.restatement.text, question.value.context.text]
        : []
      : answer.status === 'done'
        ? [answer.value.explanation, answer.value.example ?? '']
        : []
  const followUp = () => {
    chat?.followUp(shown.filter((s) => s.trim() !== '').join('\n\n'))
    onClose()
  }
  const cost = estimate === null ? null : `${t('ai.cost', { amount: formatUsd(locale, estimate) })} · ${ai.info.name}`
  const busy = current.status === 'busy'
  const partial = kind === 'question' ? questionStream.partial : answerStream.partial
  const label = kind === 'question' ? t('ai.explainQuestion') : t('review.why')

  return (
    <Sheet
      open={open}
      title={kind === 'question' ? t('ai.explainQuestion') : t('review.whyTitle')}
      onClose={onClose}
      initialFocus={region}
    >
      <div ref={region} tabIndex={-1} className={styles.region} aria-busy={busy || undefined}>
        {!online && <p className={styles.note}>{t('ai.explainOffline')}</p>}
        {busy ? (
          partial ? (
            <>
              {kind === 'question' && questionStream.partial ? (
                <PartialQuestion partial={questionStream.partial} card={card} revealed={revealed} />
              ) : (
                answerStream.partial && <PartialAnswer partial={answerStream.partial} />
              )}
              <div className={styles.row}>
                <Button variant="plain" onClick={cancel}>
                  {t('common.cancel')}
                </Button>
              </div>
            </>
          ) : (
            <div className={styles.busy}>
              <span className={styles.spinner} aria-hidden="true" />
              <p role="status">{t('ai.explaining')}</p>
              <Button variant="plain" onClick={cancel}>
                {t('common.cancel')}
              </Button>
            </div>
          )
        ) : current.status === 'failed' ? (
          <p className={styles.error} role="alert">
            {current.message}
          </p>
        ) : kind === 'question' && question.status === 'done' ? (
          <QuestionView
            value={question.value}
            revealed={revealed}
            chunks={grounding}
            query={card.front}
            guard={guard}
          />
        ) : kind === 'answer' && answer.status === 'done' ? (
          <AnswerView value={answer.value} chunks={grounding} card={card} courseId={courseId} guard={guard} />
        ) : null}
        {current.status !== 'busy' && current.status !== 'done' && (
          <div className={styles.row}>
            <Button variant="primary" disabled={!online} onClick={() => void run(kind)}>
              {current.status === 'failed' ? t('common.retry') : label}
            </Button>
          </div>
        )}
        {cost && <p className={styles.hint}>{cost}</p>}
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

/** « Why? » as it is written: the explanation, then the example and the mnemonic in their places. */
function PartialAnswer({
  partial,
}: {
  partial: NonNullable<ReturnType<typeof usePartial<CardExplanation>>['partial']>
}) {
  const t = useT()
  const writing = partial.mnemonic ? 'mnemonic' : partial.example ? 'example' : 'explanation'
  const text = (field: 'explanation' | 'example' | 'mnemonic') =>
    field === writing ? `${partial[field] ?? ''} ▍` : (partial[field] ?? '')
  return (
    <>
      {partial.explanation && (
        <div className={styles.body}>
          <Sanitized markdown={text('explanation')} />
        </div>
      )}
      {partial.example && (
        <Section title={t('review.example')}>
          <p className={styles.body}>{text('example')}</p>
        </Section>
      )}
      {partial.mnemonic && (
        <Section title={t('review.mnemonic')}>
          <p className={styles.body}>{text('mnemonic')}</p>
        </Section>
      )}
    </>
  )
}

/** « Why? » complete: the explanation, an example, a mnemonic, the cited passages and a card on this point. */
function AnswerView({
  value,
  chunks,
  card,
  courseId,
  guard,
}: {
  value: AnswerExplanation
  chunks: readonly Chunk[]
  card: { front: string; back: string }
  courseId: string | undefined
  guard: (text: string) => string
}) {
  const t = useT()
  const ws = useWorkspace()
  const [created, setCreated] = useState(false)
  const courseTitle = useWorkspaceData(['courses', { id: courseId ?? '' }], (w) =>
    courseId ? (w.courses.get(courseId)?.title ?? '') : '',
  )
  const createCard = () => {
    if (!courseId) return
    const back = [value.explanation, value.example ? `${t('review.example')}: ${value.example}` : '']
      .filter(Boolean)
      .join('\n\n')
    ws.batch(() => {
      const id = ws.cards.create({ courseId, kind: 'basic', origin: 'ai' })
      ws.text({ id, field: 'front' }).insert(0, `${t('review.why')} ${card.front}`)
      ws.text({ id, field: 'back' }).insert(0, back)
    })
    setCreated(true)
  }
  return (
    <>
      <div className={styles.body}>
        <Sanitized markdown={value.explanation} />
      </div>
      {value.example && (
        <Section title={t('review.example')}>
          <p className={styles.body}>{value.example}</p>
        </Section>
      )}
      {value.mnemonic && (
        <Section title={t('review.mnemonic')}>
          <p className={styles.body}>{value.mnemonic}</p>
        </Section>
      )}
      <Citations refs={value.citations} revealed chunks={chunks} query={`${card.front} ${card.back}`} guard={guard} />
      {courseId && (
        <div className={styles.create}>
          <Button
            variant="secondary"
            icon={<Plus size={18} strokeWidth={1.75} aria-hidden />}
            disabled={created}
            onClick={createCard}
          >
            {t('review.createCard')}
          </Button>
          {created && (
            <p className={styles.success} role="status">
              {t('review.cardCreated', { course: courseTitle })}
            </p>
          )}
        </div>
      )}
    </>
  )
}

/** Redacts answer terms in other text shown before the reveal (a source title, say). */
function useAnswerGuard(card: { front: string; back: string }, revealed: boolean) {
  const [terms] = useState<AnswerTerms>(() => answerTerms(card.front, card.back))
  return useCallback(
    (text: string): string => (revealed ? text : (guardAnswer([text], terms)[0]?.text ?? text)),
    [terms, revealed],
  )
}

/**
 * The explanation as it is written, in the places it will take once complete. Before the reveal every field is
 * checked against the card on each update, so nothing that gives the answer away shows, even for a moment.
 */
function PartialQuestion({
  partial,
  card,
  revealed,
}: {
  partial: NonNullable<ReturnType<typeof usePartial<QuestionExplanationDraft>>['partial']>
  card: { front: string; back: string }
  revealed: boolean
}) {
  const t = useT()
  const terms = (partial.terms ?? []).filter((x) => x?.term)
  const fields = [
    partial.restatement ?? '',
    partial.context ?? '',
    ...terms.flatMap((x) => [x?.term ?? '', x?.definition ?? '']),
  ]
  const safe = revealed ? fields : guardAnswer(fields, answerTerms(card.front, card.back)).map((g) => g.text)
  const at = (i: number) => safe[i] ?? ''
  const writingAt = terms.length > 0 ? 3 + 2 * (terms.length - 1) : at(1) !== '' ? 1 : 0
  const text = (i: number) => (i === writingAt ? `${at(i)} ▍` : at(i))
  return (
    <>
      <Section title={t('ai.explainAsked')}>
        <p className={styles.body}>{text(0)}</p>
      </Section>
      {terms.length > 0 && (
        <Section title={t('ai.explainTerms')}>
          <dl className={styles.terms}>
            {termSlots(terms.length).map(({ i, key }) => (
              <div key={key} className={styles.term}>
                <dt className={styles.termName}>{at(2 + 2 * i)}</dt>
                <dd className={styles.definition}>
                  <p className={styles.body}>{text(3 + 2 * i)}</p>
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
      {at(1) !== '' && (
        <Section title={t('ai.explainContext')}>
          <p className={styles.body}>{text(1)}</p>
        </Section>
      )}
    </>
  )
}

/** Streamed terms arrive in order and never reorder: their position is their identity. */
const termSlots = (n: number) => Array.from({ length: n }, (_, i) => ({ i, key: `term-${i + 1}` }))

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
