import type { ai as en } from '../en/ai.ts'
import type { Shape } from '../index.ts'

export const ai = {
  understand: 'Comprendre',
  generate: 'Générer des cartes',
  quiz: 'Interroge-moi',
  explainPrompt: 'Que voulez-vous comprendre ?',
  thinking: 'Réflexion…',
  sources: 'D’après vos sources',
  noKey: 'Ajoutez une clé d’API dans les réglages pour utiliser l’IA.',
  model: 'Modèle',
  chooseModel: 'Choisir un modèle',
  cost: 'Coût estimé : {amount}',
  generated: { one: '{count} carte générée', other: '{count} cartes générées' },
  keepAll: 'Tout garder',
  discard: 'Écarter',
  correct: 'Exact',
  incorrect: 'Pas tout à fait',
  score: 'Score : {score} / {total}',
} as const satisfies Shape<typeof en>
