import { type FormEvent, useCallback, useId, useState } from 'react'
import { paths } from '../../app/routes.ts'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import { quiz } from '../../core/ai/features/quiz'
import type { QuizQuestion } from '../../core/ai/schemas'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { cx } from '../../ui/cx.ts'
import { Screen } from '../../ui/shell/Screen.tsx'
import { useScopeOnce } from '../Section/scope.ts'
import styles from '../Understand/shared/ai.module.css'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import {
  Citation,
  NoModel,
  type Selection,
  SourcePicker,
  selectionFor,
  useChunkLoader,
} from '../Understand/shared/SourcePicker.tsx'

const COUNTS = ['3', '5', '10'] as const

/** Multiple-choice self-test. Informational only: answers never reach the review log or FSRS. */
export default function Quiz() {
  const t = useT()
  const ws = useWorkspace()
  const ai = useAiModel()
  const loadChunks = useChunkLoader()
  const opened = useScopeOnce()
  const [selection, setSelection] = useState<Selection>(() => selectionFor(opened))
  const [topic, setTopic] = useState('')
  const [count, setCount] = useState<(typeof COUNTS)[number]>('5')
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null)
  const [answers, setAnswers] = useState<Record<number, number>>({})
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const onSelection = useCallback((s: Selection) => setSelection(s), [])

  if (ai.status === 'loading') return <Screen title={t('ai.quiz')} back={paths.understand} />
  if (ai.status === 'missing')
    return (
      <Screen title={t('ai.quiz')} back={paths.understand}>
        <NoModel />
      </Screen>
    )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const chunks = await loadChunks(selection)
      const ctx = await ai.context(new AbortController().signal, ws.courses.get(selection.courseId)?.language)
      const qs = await quiz(ctx, { topic: topic.trim() || t('ai.wholeSelection'), chunks, count: Number(count) })
      setQuestions(qs)
      setAnswers({})
      setChecked(false)
    } catch (err) {
      setError(t('ai.failed', { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const score = questions?.filter((q, i) => answers[i] === q.answerIndex).length ?? 0

  return (
    <Screen title={t('ai.quiz')} back={paths.understand}>
      <form className={styles.stack} onSubmit={submit}>
        <Field label={t('ai.topicOptional')} value={topic} onChange={(e) => setTopic(e.target.value)} />
        <Segmented
          label={t('ai.questionCount')}
          value={count}
          onChange={setCount}
          options={COUNTS.map((c) => ({ value: c, label: c }))}
        />
        <SourcePicker value={selection} onChange={onSelection} />
        <div className={styles.row}>
          <Button type="submit" variant="primary" loading={busy}>
            {t('ai.startQuiz')}
          </Button>
          <span className={styles.hint}>{t('ai.quizNoFsrs')}</span>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </form>

      {questions && (
        <section className={styles.stack} aria-label={t('ai.quiz')}>
          <ol className={styles.list}>
            {questions.map((q, i) => (
              <Question
                key={q.question}
                q={q}
                index={i + 1}
                answer={answers[i]}
                checked={checked}
                onAnswer={(a) => setAnswers((prev) => ({ ...prev, [i]: a }))}
              />
            ))}
          </ol>
          {checked ? (
            <p className={styles.score} role="status">
              {t('ai.score', { score, total: questions.length })}
            </p>
          ) : (
            <div className={styles.row}>
              <Button variant="primary" onClick={() => setChecked(true)}>
                {t('ai.checkAnswers')}
              </Button>
            </div>
          )}
        </section>
      )}
    </Screen>
  )
}

function Question({
  q,
  index,
  answer,
  checked,
  onAnswer,
}: {
  q: QuizQuestion
  index: number
  answer: number | undefined
  checked: boolean
  onAnswer: (a: number) => void
}) {
  const t = useT()
  const name = useId()
  return (
    <li className={styles.card}>
      <fieldset className={styles.fieldset} disabled={checked}>
        <legend className={styles.heading}>
          {index}. {q.question}
        </legend>
        {q.choices.map((c, ci) => (
          <label
            key={c}
            className={cx(
              styles.choice,
              checked && ci === q.answerIndex && styles.choiceRight,
              checked && ci === answer && ci !== q.answerIndex && styles.choiceWrong,
            )}
          >
            <input type="radio" name={name} checked={answer === ci} onChange={() => onAnswer(ci)} />
            <span>{c}</span>
          </label>
        ))}
      </fieldset>
      {checked && (
        <div className={styles.tight}>
          <p className={answer === q.answerIndex ? styles.success : styles.error}>
            {answer === q.answerIndex ? t('ai.correct') : t('ai.incorrect')}
          </p>
          <p className={styles.body}>{q.explanation}</p>
          {q.sourceRef && <Citation sourceRef={q.sourceRef} />}
        </div>
      )}
    </li>
  )
}
