import type { review as en } from '../en/review.ts'
import type { Shape } from '../index.ts'

export const review = {
  title: 'Révision',
  showAnswer: 'Voir la réponse',
  again: 'À revoir',
  hard: 'Difficile',
  good: 'Correct',
  easy: 'Facile',
  ownWords: 'Répondez avec vos propres mots',
  ownWordsPlaceholder: 'Écrivez ce dont vous vous souvenez…',
  check: 'Vérifier',
  why: 'Pourquoi ?',
  remaining: { one: 'Encore {count}', other: 'Encore {count}' },
  sessionDone: 'Séance terminée',
  reviewed: { one: 'Vous avez révisé {count} carte.', other: 'Vous avez révisé {count} cartes.' },
  nextIn: 'Prochaine révision dans {interval}',
  leech: 'Cette carte vous échappe sans cesse. Essayez de la reformuler.',
  suspend: 'Suspendre la carte',
} as const satisfies Shape<typeof en>
