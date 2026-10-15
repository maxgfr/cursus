import { MessageCircle } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'wouter'
import { to } from '../app/routes.ts'
import { useRuntime, useWorkspace, useWorkspaceData } from '../app/workspaceContext.tsx'
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
import type { QuestionExplanationDraft, SourceRef } from '../core/ai/schemas'
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

/** A launch of « Explain the question »; a new `seq` is a new launch. */
export interface ExplainTarget {
  seq: number
}

export interface ExplainSheetProps {
  open: boolean
  onClose: () => void
  ai: Extract<AiModelState, { status: 'ready' }>
  target: ExplainTarget
  /** Course whose sources ground the explanation. */
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
 * « Explain the question » in review: what is asked, its terms and its context in the course, written as it
 * comes and never giving the answer away before the reveal. Anything broader goes to the chat (« Ask a
 * follow-up »). Loaded on demand.
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
  const stream = usePartial<QuestionExplanationDraft>()

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

  const runQuestion = useCallback(async () => {
    // One request at a time: a new one replaces whatever was running.
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    stream.reset()
    setQuestion({ status: 'busy' })
    try {
      const loaded = await loadChunks()
      const course = courseId ? ws.courses.get(courseId) : undefined
      const ctx = await ai.context(controller.signal, course?.language)
      const value = await explainQuestion(
        { ...ctx, onPartial: stream.onPartial },
        { card, revealed, chunks: loaded, courseTitle: course?.title },
      )
      if (controller.signal.aborted) return
      stream.reset()
      setQuestion({ status: 'done', value })
    } catch (error) {
      // Cancelled: `cancel` already settled the state.
      if (controller.signal.aborted) return
      stream.reset()
      console.warn('Explanation request failed', error)
      setQuestion({ status: 'failed', message: describeFailure(error, t) })
    }
  }, [loadChunks, courseId, ws, ai, card, revealed, t, stream])

  // Each launch runs once, when the sheet is open and online; a question already explained is shown again.
  useEffect(() => {
    if (!open || ran.current === target.seq) return
    ran.current = target.seq
    if (!online) return
    if (question.status === 'idle' || question.status === 'failed') void runQuestion()
  }, [open, target, online, question.status, runQuestion])

  const cancel = () => {
    abort.current?.abort()
    stream.reset()
    setQuestion(IDLE)
  }

  const guard = useAnswerGuard(card, revealed)
  const chat = useChat()
  // What was shown, as the chat opens on it: guarded fields as they appear.
  const shown = question.status === 'done' ? [question.value.restatement.text, question.value.context.text] : []
  const followUp = () => {
    chat?.followUp(shown.filter((s) => s.trim() !== '').join('\n\n'))
    onClose()
  }
  const cost = estimate === null ? null : `${t('ai.cost', { amount: formatUsd(locale, estimate) })} · ${ai.info.name}`
  const busy = question.status === 'busy'

  return (
    <Sheet open={open} title={t('ai.explainQuestion')} onClose={onClose} initialFocus={region}>
      <div ref={region} tabIndex={-1} className={styles.region} aria-busy={busy || undefined}>
        {!online && <p className={styles.note}>{t('ai.explainOffline')}</p>}
        {busy ? (
          stream.partial ? (
            <>
              <PartialQuestion partial={stream.partial} card={card} revealed={revealed} />
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
        ) : question.status === 'failed' ? (
          <p className={styles.error} role="alert">
            {question.message}
          </p>
        ) : question.status === 'done' ? (
          <QuestionView
            value={question.value}
            revealed={revealed}
            chunks={grounding}
            query={card.front}
            guard={guard}
          />
        ) : null}
        {question.status !== 'busy' && question.status !== 'done' && (
          <div className={styles.row}>
            <Button variant="primary" disabled={!online} onClick={() => void runQuestion()}>
              {question.status === 'failed' ? t('common.retry') : t('ai.explainQuestion')}
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
