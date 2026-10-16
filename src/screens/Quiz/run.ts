import type { StudyOptions } from '../../core/ai/features/tutorChat'
import type { QuizQuestion } from '../../core/ai/schemas'
import type { LocalStore } from '../../core/contracts/ports'

/**
 * The quiz under way on this device (device-local, never synced): its options, the questions written so far, the
 * choice made on each question answered, the question on screen. A reload resumes it; one still being written is
 * written again.
 */
export interface QuizRun {
  v: 1
  options: StudyOptions
  questions: QuizQuestion[]
  answers: number[]
  step: number
  writing: boolean
}

export const QUIZ_RUN_KEY = 'quiz:run'

const isRun = (v: unknown): v is QuizRun =>
  typeof v === 'object' &&
  v !== null &&
  (v as QuizRun).v === 1 &&
  Array.isArray((v as QuizRun).questions) &&
  Array.isArray((v as QuizRun).answers) &&
  typeof (v as QuizRun).step === 'number' &&
  typeof (v as QuizRun).options === 'object'

export async function loadQuizRun(store: LocalStore): Promise<QuizRun | null> {
  const v = await store.read(['kv'], (tx) => tx.get<unknown>('kv', QUIZ_RUN_KEY))
  return isRun(v) ? v : null
}

export function saveQuizRun(store: LocalStore, run: QuizRun | null): Promise<void> {
  return store.commit([
    run === null ? { delete: 'kv', key: QUIZ_RUN_KEY } : { put: 'kv', key: QUIZ_RUN_KEY, value: run },
  ])
}

/** A new quiz to write, from these options. */
export const newQuizRun = (options: StudyOptions): QuizRun => ({
  v: 1,
  options,
  questions: [],
  answers: [],
  step: 0,
  writing: true,
})
