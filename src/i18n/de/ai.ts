import type { ai as en } from '../en/ai.ts'
import type { Shape } from '../index.ts'

export const ai = {
  understand: 'Verstehen',
  generate: 'Karten erstellen',
  quiz: 'Frag mich ab',
  explainPrompt: 'Was möchtest du verstehen?',
  thinking: 'Denkt nach …',
  sources: 'Auf Basis deiner Quellen',
  noKey: 'Hinterlege in den Einstellungen einen API-Schlüssel, um die KI zu nutzen.',
  model: 'Modell',
  chooseModel: 'Modell wählen',
  cost: 'Geschätzte Kosten: {amount}',
  generated: { one: '{count} Karte erstellt', other: '{count} Karten erstellt' },
  keepAll: 'Alle behalten',
  discard: 'Verwerfen',
  correct: 'Richtig',
  incorrect: 'Nicht ganz',
  score: 'Ergebnis: {score} / {total}',
} as const satisfies Shape<typeof en>
