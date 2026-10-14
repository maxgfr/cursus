import type { course as en } from '../en/course.ts'
import type { Shape } from '../index.ts'

export const course = {
  tabCards: 'Cartes',
  tabSources: 'Sources',
  tabSheets: 'Fiches',
  name: 'Nom du cours',
  rename: 'Renommer le cours',
  deleteCourse: 'Supprimer le cours',
  deleteConfirm: 'Supprimer « {name} » et toutes ses cartes ?',
  addCard: 'Nouvelle carte',
  addSource: 'Ajouter une source',
  importPdf: 'Importer un PDF',
  takePhoto: 'Prendre une photo',
  writeNote: 'Écrire une note',
  front: 'Recto',
  back: 'Verso',
  noCards: 'Aucune carte pour l’instant. Créez-en ou générez-les à partir de vos sources.',
  noSources: 'Aucune source pour l’instant. Ajoutez des notes, des PDF ou des photos.',
  noSheets: 'Aucune fiche pour l’instant. Demandez à l’IA d’en rédiger une à partir de vos sources.',
  cardCount: { one: '{count} carte', other: '{count} cartes' },
  sourceCount: { one: '{count} source', other: '{count} sources' },
  examDate: 'Date de l’examen',
} as const satisfies Shape<typeof en>
