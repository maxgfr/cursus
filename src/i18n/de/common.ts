import type { common as en } from '../en/common.ts'
import type { Shape } from '../index.ts'

export const common = {
  appName: 'Cursus',
  save: 'Speichern',
  cancel: 'Abbrechen',
  delete: 'Löschen',
  edit: 'Bearbeiten',
  close: 'Schließen',
  back: 'Zurück',
  done: 'Fertig',
  retry: 'Erneut versuchen',
  loading: 'Wird geladen …',
  search: 'Suchen',
  confirm: 'Bestätigen',
  undo: 'Rückgängig',
  more: 'Mehr',
  today: 'Heute',
  settings: 'Einstellungen',
  offline: 'Du bist offline. Änderungen werden auf diesem Gerät gespeichert.',
  items: { one: '{count} Eintrag', other: '{count} Einträge' },
} as const satisfies Shape<typeof en>
