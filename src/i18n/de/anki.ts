import type { anki as en } from '../en/anki.ts'
import type { Shape } from '../index.ts'

export const anki = {
  importTitle: 'Aus Anki importieren',
  chooseFile: 'Wähle eine .apkg- oder .colpkg-Datei',
  importing: 'Wird importiert …',
  imported: { one: '{count} Karte importiert', other: '{count} Karten importiert' },
  skipped: { one: '{count} Karte übersprungen', other: '{count} Karten übersprungen' },
  keepHistory: 'Lernverlauf übernehmen',
  exportTitle: 'Nach Anki exportieren',
  exported: 'Stapel exportiert',
  reading: 'Paket wird gelesen …',
  previewTitle: 'In „{name}“',
  decks: 'Stapel',
  notes: 'Notizen',
  cards: 'Karten',
  reviews: 'Wiederholungen',
  media: 'Mediendateien',
  importAction: { one: '{count} Karte importieren', other: '{count} Karten importieren' },
  unreadable:
    'Diese Datei ließ sich nicht als Anki-Paket lesen. Prüfe, ob es ein aus Anki exportiertes .apkg ist. Einstellungen › Diagnose enthält die Details.',
  exportHint: 'Für den Export nach Anki nutze oben die Anki-Schaltfläche neben einem Kurs.',
} as const satisfies Shape<typeof en>
