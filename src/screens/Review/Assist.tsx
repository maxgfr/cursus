import { Lightbulb, Plus, Sparkles, Wand2 } from 'lucide-react'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import type { FeatureCtx } from '../../core/ai/client'
import type { CardExplanation, CardImprovement } from '../../core/ai/schemas'
import type { Rating } from '../../core/contracts/workspace'
import { useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Sanitized } from '../../ui/render/Sanitized.tsx'
import type { AiModelState } from '../Understand/shared/aiConfig.ts'
import styles from './Review.module.css'
import type { CardView } from './session.ts'

type Call<T> = { status: 'idle' } | { status: 'busy' } | { status: 'done'; value: T } | { status: 'failed' }

/** Runs one AI request at a time; aborts it when the card changes or the view closes. */
function useAiCall<T>(ai: AiModelState, language: string | undefined) {
  const [call, setCall] = useState<Call<T>>({ status: 'idle' })
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  const run = async (fn: (ctx: FeatureCtx) => Promise<T>): Promise<T | undefined> => {
    if (ai.status !== 'ready') return undefined
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setCall({ status: 'busy' })
    try {
      const value = await fn(await ai.context(controller.signal, language))
      if (controller.signal.aborted) return undefined
      setCall({ status: 'done', value })
      return value
    } catch (error) {
      if (controller.signal.aborted) return undefined
      // Shown to the student as a retryable message; the details stay in the console.
      console.warn('Review AI request failed', error)
      setCall({ status: 'failed' })
      return undefined
    }
  }
  return { call, run, reset: () => setCall({ status: 'idle' }) }
}

const sparkle = <Sparkles size={18} strokeWidth={1.75} aria-hidden />

/** Shown in place of an AI action while no model is set up: it leads to the AI settings. */
function SetupLink({ label }: { label: string }) {
  return (
    <Link href={paths.settingsAi} className={buttonClass({ variant: 'plain' })}>
      {sparkle}
      {label}
    </Link>
  )
}

function Failed() {
  const t = useT()
  return (
    <p className={styles.error} role="alert">
      {t('review.aiFailed')}
    </p>
  )
}

/** "Answer in your own words": the AI suggests a grade, the student confirms it. */
export function OwnWords({
  card,
  ai,
  onSuggest,
}: {
  card: CardView
  ai: AiModelState
  onSuggest: (rating: Rating, feedback: string) => void
}) {
  const t = useT()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [answer, setAnswer] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const { call, run } = useAiCall<{ rating: Rating; feedback: string }>(ai, card.language)

  useEffect(() => {
    if (open) field.current?.focus()
  }, [open])

  if (ai.status === 'loading') return null
  if (ai.status === 'missing') {
    return (
      <div className={styles.assist}>
        <SetupLink label={t('review.ownWordsSetup')} />
      </div>
    )
  }
  if (!open) {
    return (
      <div className={styles.assist}>
        <Button variant="plain" icon={sparkle} onClick={() => setOpen(true)}>
          {t('review.ownWords')}
        </Button>
      </div>
    )
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (answer.trim() === '') return
    const out = await run(async (ctx) => {
      const { gradeAnswer } = await import('../../core/ai/features/gradeAnswer')
      const g = await gradeAnswer(ctx, { front: card.front, back: card.back, answer })
      return { rating: g.suggestedRating, feedback: g.feedback }
    })
    if (out) onSuggest(out.rating, out.feedback)
  }
  return (
    <form className={styles.panel} onSubmit={submit}>
      <label htmlFor={id} className={styles.label}>
        {t('review.yourAnswer')}
      </label>
      <textarea
        id={id}
        ref={field}
        className={styles.answer}
        rows={3}
        value={answer}
        placeholder={t('review.ownWordsPlaceholder')}
        onChange={(e) => setAnswer(e.target.value)}
      />
      {call.status === 'failed' && <Failed />}
      <Button type="submit" variant="primary" loading={call.status === 'busy'} disabled={answer.trim() === ''}>
        {call.status === 'busy' ? t('review.checking') : t('review.check')}
      </Button>
    </form>
  )
}

/** "Why?": an explanation of the answer, then a card on that point. */
export function Explain({
  card,
  ai,
  onToast,
}: {
  card: CardView
  ai: AiModelState
  onToast: (message: string) => void
}) {
  const t = useT()
  const ws = useWorkspace()
  const headingId = useId()
  const [created, setCreated] = useState(false)
  const { call, run } = useAiCall<CardExplanation>(ai, card.language)

  if (ai.status === 'loading') return null
  if (ai.status === 'missing') {
    return (
      <div className={styles.assist}>
        <SetupLink label={t('review.why')} />
      </div>
    )
  }
  const ask = () =>
    run(async (ctx) => {
      const { explainCard } = await import('../../core/ai/features/explainCard')
      return explainCard(ctx, { front: card.front, back: card.back })
    })

  if (call.status !== 'done') {
    return (
      <div className={styles.assist}>
        {call.status === 'failed' && <Failed />}
        <Button
          variant="plain"
          icon={<Lightbulb size={18} strokeWidth={1.75} aria-hidden />}
          loading={call.status === 'busy'}
          onClick={() => void ask()}
        >
          {call.status === 'busy' ? t('review.explaining') : t('review.why')}
        </Button>
      </div>
    )
  }
  const { explanation, example, mnemonic } = call.value
  const createCard = () => {
    const back = [explanation, example ? `${t('review.example')}: ${example}` : ''].filter(Boolean).join('\n\n')
    ws.batch(() => {
      const id = ws.cards.create({ courseId: card.courseId, kind: 'basic', origin: 'ai' })
      ws.text({ id, field: 'front' }).insert(0, `${t('review.why')} ${card.front}`)
      ws.text({ id, field: 'back' }).insert(0, back)
    })
    setCreated(true)
    onToast(t('review.cardCreated', { course: card.courseTitle }))
  }
  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.label}>
        {t('review.whyTitle')}
      </h2>
      <Sanitized markdown={explanation} />
      {example && (
        <p className={styles.aside}>
          <strong>{t('review.example')}</strong> {example}
        </p>
      )}
      {mnemonic && (
        <p className={styles.aside}>
          <strong>{t('review.mnemonic')}</strong> {mnemonic}
        </p>
      )}
      <Button
        variant="secondary"
        icon={<Plus size={18} strokeWidth={1.75} aria-hidden />}
        disabled={created}
        onClick={createCard}
      >
        {t('review.createCard')}
      </Button>
    </section>
  )
}

/** Leech: a badge, the reason, and an AI rewrite the student can accept. */
export function Improve({
  card,
  ai,
  onSuspend,
  onToast,
}: {
  card: CardView
  ai: AiModelState
  onSuspend: () => void
  onToast: (message: string) => void
}) {
  const t = useT()
  const ws = useWorkspace()
  const { call, run, reset } = useAiCall<CardImprovement>(ai, card.language)

  const apply = (next: CardImprovement) => {
    ws.batch(() => {
      for (const [field, value] of [
        ['front', next.front],
        ['back', next.back],
      ] as const) {
        const text = ws.text({ id: card.id, field })
        text.delete(0, text.length)
        text.insert(0, value)
      }
    })
    reset()
    onToast(t('review.improved'))
  }

  return (
    <aside className={styles.leech}>
      <div className={styles.leechHead}>
        <span className={styles.leechBadge}>{t('review.leechBadge')}</span>
        <p className={styles.leechText}>{t('review.leech')}</p>
      </div>
      {call.status === 'done' ? (
        <div className={styles.proposal}>
          <h2 className={styles.label}>{t('review.improveTitle')}</h2>
          <div className={styles.proposalFace}>
            <span className={styles.label}>{t('review.question')}</span>
            <Sanitized markdown={call.value.front} />
          </div>
          <div className={styles.proposalFace}>
            <span className={styles.label}>{t('review.answer')}</span>
            <Sanitized markdown={call.value.back} />
          </div>
          <p className={styles.aside}>{call.value.rationale}</p>
          <div className={styles.row}>
            <Button variant="primary" onClick={() => apply(call.value)}>
              {t('review.applyImprovement')}
            </Button>
            <Button variant="plain" onClick={reset}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.row}>
          {call.status === 'failed' && <Failed />}
          {ai.status === 'missing' ? (
            <SetupLink label={t('review.improve')} />
          ) : (
            <Button
              variant="secondary"
              icon={<Wand2 size={18} strokeWidth={1.75} aria-hidden />}
              loading={call.status === 'busy'}
              disabled={ai.status === 'loading'}
              onClick={() =>
                void run(async (ctx) => {
                  const { improveCard } = await import('../../core/ai/features/improveCard')
                  return improveCard(ctx, { front: card.rawFront, back: card.rawBack, kind: card.kind })
                })
              }
            >
              {call.status === 'busy' ? t('review.improving') : t('review.improve')}
            </Button>
          )}
          <Button variant="plain" onClick={onSuspend}>
            {t('review.suspend')}
          </Button>
        </div>
      )}
    </aside>
  )
}
