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
} as const satisfies Shape<typeof en>
