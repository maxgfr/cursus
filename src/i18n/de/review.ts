import type { review as en } from '../en/review.ts'
import type { Shape } from '../index.ts'

export const review = {
  title: 'Wiederholen',
  showAnswer: 'Antwort zeigen',
  again: 'Nochmal',
  hard: 'Schwer',
  good: 'Gut',
  easy: 'Leicht',
  ownWords: 'Antworte in eigenen Worten',
  ownWordsPlaceholder: 'Schreib auf, was du noch weißt …',
  check: 'Prüfen',
  why: 'Warum?',
  remaining: { one: 'Noch {count}', other: 'Noch {count}' },
  sessionDone: 'Runde geschafft',
  reviewed: { one: 'Du hast {count} Karte wiederholt.', other: 'Du hast {count} Karten wiederholt.' },
  nextIn: 'Nächste Wiederholung in {interval}',
  leech: 'Diese Karte will einfach nicht hängen bleiben. Formulier sie doch neu.',
  suspend: 'Karte aussetzen',
} as const satisfies Shape<typeof en>
