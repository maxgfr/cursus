import { MessageCircle, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { paths } from '../../app/routes.ts'
import { useRuntime } from '../../app/workspaceContext.tsx'
import type { QuizQuestion } from '../../core/ai/schemas'
import { useT } from '../../i18n/react.tsx'
import { QuizStep } from '../../ui/ai/QuizStep.tsx'
import { useAiReadiness } from '../../ui/ai/ready.ts'
import { useChat, useChatContext } from '../../ui/chat/context.tsx'
import { chunkLoader, runQuiz } from '../../ui/chat/studyRun.ts'
import { Button } from '../../ui/components/Button.tsx'
import { useCanCallAi } from '../../ui/ExplainLauncher.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { describeFailure } from '../Review/failure.ts'
import { QuizSetup } from '../Sessions/QuizSheet.tsx'
import shared from '../Understand/shared/ai.module.css'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import { NoModel } from '../Understand/shared/SourcePicker.tsx'
import { loadQuizRun, newQuizRun, type QuizRun, saveQuizRun } from './run.ts'

/** A question ready to be asked while the quiz is written: complete, and followed by the next one. */
const complete = (q: Partial<QuizQuestion> | undefined): q is QuizQuestion =>
  typeof q?.question === 'string' &&
  Array.isArray(q.choices) &&
  q.choices.length >= 2 &&
  typeof q.answerIndex === 'number' &&
  typeof q.explanation === 'string'

/**
 * « Quiz me »: set up here or from a course, then written by AI and asked one question at a time, each corrected with
 * why and the passage it comes from; a question is asked as soon as it is written. At the end the score, the
 * questions missed (each can be asked about in the chat), the same questions again, or a new quiz. Kept on this
 * device: a reload resumes it. Never graded into the review schedule.
 */
export default function Quiz() {
  const t = useT()
  const rt = useRuntime()
  const readiness = useAiReadiness()
  const ai = useAiModel()
  const callable = useCanCallAi(ai)
  const chat = useChat()
  const [run, setRunState] = useState<QuizRun | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    let live = true
    loadQuizRun(rt.store).then(
      (r) => live && setRunState(r),
      () => live && setRunState(null),
    )
    return () => {
      live = false
    }
  }, [rt])
  const setRun = useCallback(
    (next: QuizRun | null) => {
      setRunState(next)
      saveQuizRun(rt.store, next).catch((e: unknown) => console.warn('quiz not kept', e))
    },
    [rt],
  )
  const current = useRef(run)
  current.current = run

  const ready = ai.status === 'ready' ? ai : null
  const load = useMemo(() => chunkLoader(rt.ws, rt), [rt])

  // A quiz to write: written as soon as the model can be called, its questions asked as they come.
  const writing = run?.writing === true
  useEffect(() => {
    if (!writing || !ready || !callable || abort.current) return
    const started = current.current
    if (!started) return
    const ctl = new AbortController()
    abort.current = ctl
    setError(null)
    const keep = (questions: QuizQuestion[], done: boolean) => {
      const now = current.current
      if (!now || now.options !== started.options) return
      setRun({ ...now, questions, writing: !done })
    }
    runQuiz({ ws: rt.ws, rt, ai: ready, t, load }, started.options, {
      signal: ctl.signal,
      onPartial: (p) => {
        const written = ((p as { questions?: Partial<QuizQuestion>[] }).questions ?? []).slice(0, -1).filter(complete)
        if (written.length > (current.current?.questions.length ?? 0)) keep(written, false)
      },
    })
      .then((questions) => keep(questions, true))
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return
        console.warn('quiz not written', e)
        setError(t('chat.failed', { reason: describeFailure(e, t) }))
        const now = current.current
        if (now) setRun({ ...now, writing: false })
      })
      .finally(() => {
        if (abort.current === ctl) abort.current = null
      })
  }, [writing, ready, callable, rt, t, load, setRun])

  const stop = () => {
    abort.current?.abort()
    abort.current = null
    if (run) setRun({ ...run, writing: false })
  }

  const q = run?.questions[run.step]
  const place = run
    ? { courseId: run.options.courseId, ...(run.options.sectionId ? { sectionId: run.options.sectionId } : {}) }
    : null
  useChatContext(place && place.courseId !== '' ? { ...place, ...(q ? { question: q.question } : {}) } : {})

  if (readiness === 'missing') {
    return (
      <Screen title={t('ai.quiz')} back={paths.sessions}>
        <NoModel reason={ai.status === 'missing' ? ai.reason : undefined} />
      </Screen>
    )
  }
  if (run === undefined) return <Screen title={t('ai.quiz')} back={paths.sessions} />
  if (run === null) {
    return (
      <Screen title={t('ai.quiz')} back={paths.sessions}>
        <QuizSetup onStart={(options) => setRun(newQuizRun(options))} />
      </Screen>
    )
  }

  const { questions, answers, step } = run
  const answered = answers[step]
  const done = !run.writing && questions.length > 0 && answers.length === questions.length
  const score = questions.filter((x, i) => answers[i] === x.answerIndex).length
  const missed = questions.filter((x, i) => answers[i] !== undefined && answers[i] !== x.answerIndex)
  const choose = (ci: number) => {
    if (answers.length !== step) return
    setRun({ ...run, answers: [...answers, ci] })
  }
  const amount =
    run.options.count === 'all' ? t('chat.allQuestions') : t('chat.questions', { count: run.options.count })
  const difficulty = { easy: t('ai.quizEasy'), standard: t('ai.quizStandard'), hard: t('ai.quizHard') }[
    run.options.difficulty ?? 'standard'
  ]
  return (
    <Screen title={t('ai.quiz')} back={paths.sessions}>
      <div className={shared.stack}>
        <p className={shared.hint}>
          {amount} · {difficulty}
        </p>
        <p className={shared.hint}>{t('ai.quizNoFsrs')}</p>
        {q ? (
          <QuizStep q={q} index={step} total={questions.length} answer={answered} onChoose={choose} />
        ) : (
          <p className={shared.muted} role="status">
            {run.writing ? t('chat.writing') : error === null ? t('chat.quizEmpty') : ''}
          </p>
        )}
        {answered !== undefined && step < questions.length - 1 && (
          <div className={shared.row}>
            <Button variant="primary" onClick={() => setRun({ ...run, step: step + 1 })}>
              {t('chat.nextQuestion')}
            </Button>
          </div>
        )}
        {answered !== undefined && step === questions.length - 1 && run.writing && (
          <p className={shared.muted} role="status">
            {t('chat.writing')}
          </p>
        )}
        {run.writing && (
          <div className={shared.row}>
            <Button variant="secondary" onClick={stop}>
              {t('chat.stop')}
            </Button>
          </div>
        )}
        {error && (
          <p className={shared.error} role="alert">
            {error}
          </p>
        )}
        {done && (
          <section className={shared.stack} aria-label={t('ai.quizSummary')}>
            <p className={shared.score} role="status">
              {t('ai.score', { score, total: questions.length })}
            </p>
            {missed.length > 0 && (
              <ul className={shared.list}>
                {missed.map((m) => (
                  <li key={m.question} className={shared.card}>
                    <p className={shared.body}>{m.question}</p>
                    {chat && (
                      <Button
                        variant="plain"
                        icon={<MessageCircle size={18} aria-hidden="true" />}
                        onClick={() => chat.ask(t('ai.quizAskChat', { question: m.question }), m.explanation)}
                      >
                        {t('ai.quizAskChatButton')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className={shared.row}>
              <Button
                variant="secondary"
                icon={<RotateCcw size={18} aria-hidden="true" />}
                onClick={() => setRun({ ...run, answers: [], step: 0 })}
              >
                {t('ai.quizAgain')}
              </Button>
              <Button variant="primary" onClick={() => setRun(null)}>
                {t('ai.quizNew')}
              </Button>
            </div>
          </section>
        )}
      </div>
    </Screen>
  )
}
