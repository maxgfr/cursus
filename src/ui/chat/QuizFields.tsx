import { useId } from 'react'
import type { StudyOptions } from '../../core/ai/features/tutorChat'
import { QUIZ_COUNTS } from '../../core/model/quizPlan'
import { useT } from '../../i18n/react.tsx'
import shared from '../../screens/Understand/shared/ai.module.css'
import { Segmented } from '../components/Segmented.tsx'

type Difficulty = NonNullable<StudyOptions['difficulty']>
type Count = `${(typeof QUIZ_COUNTS)[number]}`

/**
 * A quiz's own settings: how many questions, how hard, and whether the place's weak points come first (offered
 * when it has some; `weak` is how many). Shared by the quiz's set-up and the options under its answer.
 */
export function QuizFields({
  value,
  onChange,
  weak,
}: {
  value: Pick<StudyOptions, 'count' | 'difficulty' | 'focusWeak'>
  onChange: (patch: Partial<StudyOptions>) => void
  weak: number
}) {
  const t = useT()
  const hintId = useId()
  return (
    <>
      <Segmented<Count>
        label={t('ai.questionCount')}
        value={String(value.count) as Count}
        onChange={(c) => onChange({ count: c === 'all' ? 'all' : Number(c) })}
        options={QUIZ_COUNTS.map((c) => ({
          value: String(c) as Count,
          label: c === 'all' ? t('ai.quizAll') : String(c),
        }))}
      />
      <Segmented<Difficulty>
        label={t('ai.quizDifficulty')}
        value={value.difficulty ?? 'standard'}
        onChange={(difficulty) => onChange({ difficulty })}
        options={[
          { value: 'easy', label: t('ai.quizEasy') },
          { value: 'standard', label: t('ai.quizStandard') },
          { value: 'hard', label: t('ai.quizHard') },
        ]}
      />
      <div>
        <label className={shared.check}>
          <input
            type="checkbox"
            checked={weak > 0 && value.focusWeak === true}
            disabled={weak === 0}
            aria-describedby={hintId}
            onChange={(e) => onChange({ focusWeak: e.target.checked })}
          />
          {t('ai.quizFocusWeak')}
        </label>
        <p id={hintId} className={shared.hint}>
          {weak > 0 ? t('ai.quizFocusHint', { count: weak }) : t('ai.quizFocusNone')}
        </p>
      </div>
    </>
  )
}
