import type { today as en } from '../en/today.ts'
import type { Shape } from '../index.ts'

export const today = {
  title: 'Aujourd’hui',
  greeting: 'Content de vous revoir',
  due: { one: '{count} carte à revoir', other: '{count} cartes à revoir' },
  newCards: { one: '{count} nouvelle carte', other: '{count} nouvelles cartes' },
  start: 'Commencer la révision',
  allDone: 'Tout est fait pour aujourd’hui. À demain !',
  courses: 'Cours',
  addCourse: 'Nouveau cours',
  noCourses: 'Aucun cours pour l’instant. Créez-en un pour commencer.',
  streak: { one: '{count} jour d’affilée', other: '{count} jours d’affilée' },
  examIn: { one: 'Examen dans {count} jour', other: 'Examen dans {count} jours' },
} as const satisfies Shape<typeof en>
