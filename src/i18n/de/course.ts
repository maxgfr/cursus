import type { course as en } from '../en/course.ts'
import type { Shape } from '../index.ts'

export const course = {
  tabCards: 'Karten',
  tabSources: 'Quellen',
  tabSheets: 'Spickzettel',
  name: 'Kursname',
  rename: 'Kurs umbenennen',
  deleteCourse: 'Kurs löschen',
  deleteConfirm: '„{name}“ samt allen Karten löschen?',
  addCard: 'Neue Karte',
  addSource: 'Quelle hinzufügen',
  importPdf: 'PDF importieren',
  takePhoto: 'Foto aufnehmen',
  writeNote: 'Notiz schreiben',
  front: 'Vorderseite',
  back: 'Rückseite',
  noCards: 'Noch keine Karten. Leg selbst welche an oder lass sie aus deinen Quellen erstellen.',
  noSources: 'Noch keine Quellen. Füge Notizen, PDFs oder Fotos hinzu.',
  noSheets: 'Noch keine Spickzettel. Lass die KI einen aus deinen Quellen schreiben.',
  cardCount: { one: '{count} Karte', other: '{count} Karten' },
  sourceCount: { one: '{count} Quelle', other: '{count} Quellen' },
  examDate: 'Prüfungstermin',
} as const satisfies Shape<typeof en>
