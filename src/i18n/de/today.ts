import type { today as en } from '../en/today.ts'
import type { Shape } from '../index.ts'

export const today = {
  title: 'Heute',
  greeting: 'Schön, dass du da bist',
  due: { one: '{count} Karte fällig', other: '{count} Karten fällig' },
  newCards: { one: '{count} neue Karte', other: '{count} neue Karten' },
  start: 'Lernen starten',
  allDone: 'Für heute alles erledigt. Bis morgen!',
  courses: 'Kurse',
  addCourse: 'Neuer Kurs',
  noCourses: 'Noch keine Kurse. Leg einen an, um loszulegen.',
  streak: { one: '{count} Tag in Folge', other: '{count} Tage in Folge' },
  examIn: { one: 'Prüfung in {count} Tag', other: 'Prüfung in {count} Tagen' },
} as const satisfies Shape<typeof en>
