import { Check, X } from 'lucide-react'
import type { QuizQuestion } from '../../core/ai/schemas'
import { useT } from '../../i18n/react.tsx'
import shared from '../../screens/Understand/shared/ai.module.css'
import { Citation } from '../../screens/Understand/shared/SourcePicker.tsx'
import styles from '../chat/Study.module.css'
import { cx } from '../cx.ts'
import { keyedChoices } from './keyed.ts'

/** A quiz question: its choices, then, once one is picked, the correction (right ringed green, a wrong pick red), why, and the passage it comes from. */
export function QuizStep({
  q,
  index,
  total,
  answer,
  onChoose,
}: {
  q: QuizQuestion
  index: number
  total: number
  answer: number | undefined
  onChoose: (choice: number) => void
}) {
  const t = useT()
  const checked = answer !== undefined
  return (
    <fieldset className={cx(shared.fieldset, shared.card)}>
      <legend className={styles.legend}>
        <span className={shared.hint}>{t('chat.questionOf', { n: String(index + 1), total: String(total) })}</span>{' '}
        <span className={shared.heading}>{q.question}</span>
      </legend>
      <ul className={styles.choices}>
        {keyedChoices(q.choices).map(({ item: c, key, at: ci }) => (
          <li key={key}>
            <button
              type="button"
              className={cx(
                styles.choice,
                checked && ci === q.answerIndex && styles.right,
                checked && ci === answer && ci !== q.answerIndex && styles.wrong,
              )}
              aria-pressed={checked ? ci === answer : undefined}
              disabled={checked}
              onClick={() => onChoose(ci)}
            >
              <span>{c}</span>
              {checked && ci === q.answerIndex && <Check size={18} className={styles.mark} aria-hidden="true" />}
              {checked && ci === answer && ci !== q.answerIndex && (
                <X size={18} className={styles.mark} aria-hidden="true" />
              )}
            </button>
          </li>
        ))}
      </ul>
      {checked && (
        <div className={shared.tight} role="status">
          <p className={answer === q.answerIndex ? shared.success : shared.error}>
            {answer === q.answerIndex ? t('ai.correct') : t('ai.incorrect')}
          </p>
          <p className={shared.body}>{q.explanation}</p>
          {q.sourceRef && <Citation sourceRef={q.sourceRef} />}
        </div>
      )}
    </fieldset>
  )
}
