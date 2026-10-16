/** The course or section last quizzed on this device (a convenience: the quiz opens there next time). */
export const LAST_QUIZ_KEY = 'cursus:quiz:last'

export function readLastQuiz(): string {
  try {
    return localStorage.getItem(LAST_QUIZ_KEY) ?? ''
  } catch {
    return ''
  }
}

export function writeLastQuiz(value: string): void {
  try {
    localStorage.setItem(LAST_QUIZ_KEY, value)
  } catch {
    // Storage refused: the next quiz opens on the default place.
  }
}
