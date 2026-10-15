import type { DeepPartial } from 'ai'
import { Sparkles, Wand2 } from 'lucide-react'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import type { FeatureCtx } from '../../core/ai/client'
import type { CardImprovement } from '../../core/ai/schemas'
import type { Rating } from '../../core/contracts/workspace'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { usePartial } from '../../ui/data/usePartial.ts'
import { Sanitized } from '../../ui/render/Sanitized.tsx'
import { type AiModelState, cardText } from '../Understand/shared/aiConfig.ts'
import { describeFailure } from './failure.ts'
import styles from './Review.module.css'
import type { CardView } from './session.ts'

type Call<T> =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'done'; value: T }
  | { status: 'failed'; message: string }

/**
 * Runs one AI request at a time, its answer shown as it is written (`partial`); aborts it when the card changes
 * or the view closes. `S` is the shape the model writes, `T` what the request returns.
 */
function useAiCall<T, S = T>(ai: AiModelState, language: string | undefined, content?: string) {
  const t = useT()
  const [call, setCall] = useState<Call<T>>({ status: 'idle' })
  const stream = usePartial<S>()
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  const run = async (fn: (ctx: FeatureCtx) => Promise<T>): Promise<T | undefined> => {
    if (ai.status !== 'ready') return undefined
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    stream.reset()
    setCall({ status: 'busy' })
    try {
      const ctx = await ai.context(controller.signal, language, content)
      const value = await fn({ ...ctx, onPartial: stream.onPartial })
      if (controller.signal.aborted) return undefined
      stream.reset()
      setCall({ status: 'done', value })
      return value
    } catch (error) {
      if (controller.signal.aborted) return undefined
      stream.reset()
      // Shown to the student as a retryable message; the details stay in the console.
      console.warn('Review AI request failed', error)
      setCall({ status: 'failed', message: describeFailure(error, t) })
      return undefined
    }
  }
  const partial: DeepPartial<S> | null = call.status === 'busy' ? stream.partial : null
  return { call, partial, run, reset: () => setCall({ status: 'idle' }) }
}

/** Text still being written ends with a cursor. */
const writing = (text: string | undefined) => (text ? `${text} ▍` : '')

const sparkle = <Sparkles size={18} strokeWidth={1.75} aria-hidden />

/** Shown in place of an AI action while no model is set up: a quiet link to the AI settings. */
function SetupLink({ label }: { label: string }) {
  return (
    <Link href={paths.settingsAi} className={styles.setupLink}>
      {label}
    </Link>
  )
}

function Failed({ message }: { message: string }) {
  return (
    <p className={styles.error} role="alert">
      {message}
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
  const { call, partial, run } = useAiCall<{ rating: Rating; feedback: string }, { feedback: string }>(
    ai,
    card.language,
    cardText(card),
  )

  useEffect(() => {
    if (open) field.current?.focus()
  }, [open])

  // Only offered once a model is configured; the setup path lives in Understand and Settings, not
  // in the focus view.
  if (ai.status !== 'ready') return null
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
      {call.status === 'failed' && <Failed message={call.message} />}
      {partial?.feedback && (
        <p className={styles.aside} aria-live="off">
          {writing(partial.feedback)}
        </p>
      )}
      <Button type="submit" variant="primary" loading={call.status === 'busy'} disabled={answer.trim() === ''}>
        {call.status === 'busy' ? t('review.checking') : t('review.check')}
      </Button>
    </form>
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
  const { call, partial, run, reset } = useAiCall<CardImprovement>(ai, card.language, cardText(card))

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
      {call.status === 'busy' && partial?.front ? (
        <div className={styles.proposal} aria-busy="true">
          <h2 className={styles.label}>{t('review.improveTitle')}</h2>
          <div className={styles.proposalFace}>
            <span className={styles.label}>{t('review.question')}</span>
            <Sanitized markdown={partial.back ? partial.front : writing(partial.front)} />
          </div>
          {partial.back && (
            <div className={styles.proposalFace}>
              <span className={styles.label}>{t('review.answer')}</span>
              <Sanitized markdown={writing(partial.back)} />
            </div>
          )}
        </div>
      ) : call.status === 'done' ? (
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
          {call.status === 'failed' && <Failed message={call.message} />}
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
