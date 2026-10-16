import type { DeepPartial } from 'ai'
import { ChevronDown } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import type { ExplainBackReview } from '../../core/ai/schemas'
import { useT } from '../../i18n/react.tsx'
import shared from '../../screens/Understand/shared/ai.module.css'
import { Button } from '../components/Button.tsx'
import { keyedChoices } from './keyed.ts'

/**
 * Feynman check, folded: the student explains the topic back and gets strengths, gaps and misconceptions against
 * the sources (`check`). The review shown is `review` when given (kept by the caller, `onReview`), else its own.
 */
export function ExplainBack({
  check,
  blocked,
  review: kept,
  onReview,
}: {
  check: (explanation: string, onPartial: (p: unknown) => void) => Promise<ExplainBackReview>
  /** The model cannot be called now (offline, or busy writing). */
  blocked: boolean
  review?: ExplainBackReview
  onReview?: (review: ExplainBackReview) => void
}) {
  const t = useT()
  const field = useId()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [partial, setPartial] = useState<DeepPartial<ExplainBackReview> | null>(null)
  const [own, setOwn] = useState<ExplainBackReview | undefined>(undefined)
  const review = kept ?? own
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setError('')
    setPartial(null)
    try {
      const out = await check(text.trim(), (p) => setPartial(p as DeepPartial<ExplainBackReview>))
      setOwn(out)
      onReview?.(out)
    } catch (err) {
      setError(t('ai.failed', { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setPartial(null)
      setBusy(false)
    }
  }
  const writing = busy ? partial : null
  return (
    <details className={shared.disclosure}>
      <summary className={shared.disclosureSummary}>
        <span className={shared.disclosureLabel}>{t('ai.checkUnderstood')}</span>
        <ChevronDown size={18} aria-hidden="true" className={shared.chevron} />
      </summary>
      <div className={shared.disclosureBody}>
        <p className={shared.muted}>{t('ai.explainBackHint')}</p>
        <form className={shared.tight} onSubmit={submit}>
          <label htmlFor={field} className="sr-only">
            {t('ai.explainBackLabel')}
          </label>
          <textarea
            id={field}
            className={shared.textarea}
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className={shared.row}>
            <Button type="submit" loading={busy} disabled={!text.trim() || blocked}>
              {t('ai.checkExplanation')}
            </Button>
          </div>
          {error && (
            <p className={shared.error} role="alert">
              {error}
            </p>
          )}
        </form>
        {writing?.feedback && (
          <div className={shared.tight} aria-busy="true">
            {typeof writing.score === 'number' && (
              <p className={shared.score}>{t('ai.explainScore', { score: Math.round(writing.score) })}</p>
            )}
            <p className={shared.body}>{writing.feedback} ▍</p>
          </div>
        )}
        {review && !busy && (
          <div className={shared.tight} role="status">
            <p className={shared.score}>{t('ai.explainScore', { score: Math.round(review.score) })}</p>
            <p className={shared.body}>{review.feedback}</p>
            <ReviewList title={t('ai.strengths')} items={review.strengths} />
            <ReviewList title={t('ai.gaps')} items={review.gaps} />
            <ReviewList title={t('ai.misconceptions')} items={review.misconceptions} />
          </div>
        )}
      </div>
    </details>
  )
}

function ReviewList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className={shared.tight}>
      <h3 className={shared.label}>{title}</h3>
      <ul className={shared.bullets}>
        {keyedChoices(items).map(({ item, key }) => (
          <li key={key}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
