import type { DeepPartial } from 'ai'
import { Plus } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'wouter'
import { to } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { AnswerExplanation } from '../../core/ai/features/explainCard'
import {
  answerTerms,
  foldWord,
  type GuardedText,
  guardAnswer,
  type QuestionExplanation,
} from '../../core/ai/features/explainQuestion'
import type { RichResult } from '../../core/ai/features/tutorChat'
import type { Chunk } from '../../core/ai/retrieval'
import type { CardExplanation, QuestionExplanationDraft, SourceRef } from '../../core/ai/schemas'
import { useT } from '../../i18n/react.tsx'
import { citationText, useCitedUnit } from '../../screens/Understand/shared/citations.ts'
import { PASTED } from '../../screens/Understand/shared/sources.ts'
import { Button } from '../components/Button.tsx'
import { Sanitized } from '../render/Sanitized.tsx'
import styles from './RichAnswer.module.css'

type Faces = { front: string; back: string }

/** Items with a React key from their content, repeats told apart by their rank among equals. */
export function keyed<T>(items: readonly T[], keyOf: (item: T) => string): { item: T; key: string }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = keyOf(item)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return { item, key: n === 1 ? base : `${base}#${n}` }
  })
}

const shownText = (g: GuardedText, open: boolean) => (open ? (g.original ?? g.text) : g.text)

/**
 * « Explain the question » or « Why? » as the thread keeps it. Until `revealed`, nothing shown gives the card's
 * answer away: guarded fields show redacted with « Show anyway », citations are links without their passage and
 * source titles are guarded too. After the reveal everything shows, the cited passages included.
 */
export function RichAnswer({
  rich,
  revealed,
  chunks,
  courseId,
  footer,
}: {
  rich: RichResult
  revealed: boolean
  /** The course's passages, from which the cited ones are quoted. */
  chunks: readonly Chunk[]
  /** Where a card on this point goes. */
  courseId: string | undefined
  footer?: ReactNode
}) {
  const guard = useAnswerGuard(rich.card, revealed)
  return (
    <div className={styles.rich}>
      {rich.kind === 'explainQuestion' ? (
        <QuestionView value={rich.value} revealed={revealed} chunks={chunks} query={rich.card.front} guard={guard} />
      ) : (
        <AnswerView
          value={rich.value}
          revealed={revealed}
          chunks={chunks}
          card={rich.card}
          courseId={courseId}
          guard={guard}
        />
      )}
      {footer}
    </div>
  )
}

/** A structured answer as it is written, in the places it will take once complete. */
export function PartialRich({
  kind,
  question,
  answer,
  card,
  revealed,
}: {
  kind: RichResult['kind']
  question: DeepPartial<QuestionExplanationDraft> | null
  answer: DeepPartial<CardExplanation> | null
  card: Faces
  revealed: boolean
}) {
  return (
    <div className={styles.rich}>
      {kind === 'explainQuestion'
        ? question && <PartialQuestion partial={question} card={card} revealed={revealed} />
        : answer && <PartialAnswer partial={answer} card={card} revealed={revealed} />}
    </div>
  )
}

/**
 * « Why? » as it is written: the explanation, then the example and the mnemonic in their places. Before the reveal
 * every field is checked against the card on each update, like the question's explanation.
 */
function PartialAnswer({
  partial,
  card,
  revealed,
}: {
  partial: DeepPartial<CardExplanation>
  card: Faces
  revealed: boolean
}) {
  const t = useT()
  const writing = partial.mnemonic ? 'mnemonic' : partial.example ? 'example' : 'explanation'
  const fields = [partial.explanation ?? '', partial.example ?? '', partial.mnemonic ?? '']
  const safe = revealed ? fields : guardAnswer(fields, answerTerms(card.front, card.back)).map((g) => g.text)
  const index = { explanation: 0, example: 1, mnemonic: 2 } as const
  const text = (field: 'explanation' | 'example' | 'mnemonic') => {
    const value = safe[index[field]] ?? ''
    return field === writing ? `${value} ▍` : value
  }
  return (
    <>
      {partial.explanation &&
        (revealed ? (
          <div className={styles.body}>
            <Sanitized markdown={text('explanation')} />
          </div>
        ) : (
          <p className={styles.body}>{text('explanation')}</p>
        ))}
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
  revealed,
  chunks,
  card,
  courseId,
  guard,
}: {
  value: AnswerExplanation
  revealed: boolean
  chunks: readonly Chunk[]
  card: Faces
  courseId: string | undefined
  guard: (text: string) => string
}) {
  const t = useT()
  const ws = useWorkspace()
  const [created, setCreated] = useState(false)
  const courseTitle = useWorkspaceData(['courses', { id: courseId ?? '' }], (w) =>
    courseId ? (w.courses.get(courseId)?.title ?? '') : '',
  )
  const terms = useMemo(() => answerTerms(card.front, card.back), [card.front, card.back])
  const [explanation, example, mnemonic] = useMemo(
    () => guardAnswer([value.explanation, value.example ?? '', value.mnemonic ?? ''], terms),
    [value.explanation, value.example, value.mnemonic, terms],
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
      {revealed ? (
        <div className={styles.body}>
          <Sanitized markdown={value.explanation} />
        </div>
      ) : (
        explanation && <Guarded value={explanation} revealed={false} />
      )}
      {value.example && (
        <Section title={t('review.example')}>
          {revealed ? (
            <p className={styles.body}>{value.example}</p>
          ) : (
            example && <Guarded value={example} revealed={false} />
          )}
        </Section>
      )}
      {value.mnemonic && (
        <Section title={t('review.mnemonic')}>
          {revealed ? (
            <p className={styles.body}>{value.mnemonic}</p>
          ) : (
            mnemonic && <Guarded value={mnemonic} revealed={false} />
          )}
        </Section>
      )}
      <Citations
        refs={value.citations}
        revealed={revealed}
        chunks={chunks}
        query={`${card.front} ${card.back}`}
        guard={guard}
      />
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
function useAnswerGuard(card: Faces, revealed: boolean) {
  const terms = useMemo(() => answerTerms(card.front, card.back), [card.front, card.back])
  return useCallback(
    (text: string): string => (revealed ? text : (guardAnswer([text], terms)[0]?.text ?? text)),
    [terms, revealed],
  )
}

/**
 * The question's explanation as it is written. Before the reveal every field is checked against the card on each
 * update, so nothing that gives the answer away shows, even for a moment.
 */
function PartialQuestion({
  partial,
  card,
  revealed,
}: {
  partial: DeepPartial<QuestionExplanationDraft>
  card: Faces
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

/** A line under an answer, in the thread's quiet style (the estimated cost, say). */
export function RichNote({ children }: { children: ReactNode }) {
  return <p className={styles.hint}>{children}</p>
}
