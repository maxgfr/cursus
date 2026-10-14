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
  reading: 'Lecture du paquet…',
  previewTitle: 'Dans « {name} »',
  decks: 'Paquets',
  notes: 'Notes',
  cards: 'Cartes',
  reviews: 'Révisions',
  media: 'Fichiers médias',
  importAction: { one: 'Importer {count} carte', other: 'Importer {count} cartes' },
  unreadable:
    'Ce fichier n’a pas pu être lu comme un paquet Anki. Vérifiez qu’il s’agit d’un .apkg exporté d’Anki. Réglages › Diagnostic garde les détails.',
  exportHint: 'Pour exporter vers Anki, utilisez le bouton Anki à côté d’un cours ci-dessus.',
} as const satisfies Shape<typeof en>
