import type { anki as en } from '../en/anki.ts'
import type { Shape } from '../index.ts'

export const anki = {
  importTitle: 'Importer depuis Anki',
  chooseFile: 'Choisissez un fichier .apkg ou .colpkg',
  importing: 'Importation…',
  imported: { one: '{count} carte importée', other: '{count} cartes importées' },
  skipped: { one: '{count} carte ignorée', other: '{count} cartes ignorées' },
  keepHistory: 'Conserver l’historique de révision',
  exportTitle: 'Exporter vers Anki',
  exported: 'Paquet exporté',
} as const satisfies Shape<typeof en>
