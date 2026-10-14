import type { settings as en } from '../en/settings.ts'
import type { Shape } from '../index.ts'

export const settings = {
  title: 'Einstellungen',
  language: 'Sprache',
  languageAuto: 'Gerätesprache',
  theme: 'Darstellung',
  themeSystem: 'System',
  themeLight: 'Hell',
  themeDark: 'Dunkel',
  apiKey: 'API-Schlüssel',
  apiKeyHint: 'Dein Schlüssel bleibt auf deinen Geräten.',
  dailyNew: 'Neue Karten pro Tag',
  dailyMax: 'Maximale Wiederholungen pro Tag',
  retention: 'Angestrebte Behaltensquote',
  sync: 'Synchronisierung & Backup',
  about: 'Über',
  version: 'Version {version}',
  exportData: 'Daten exportieren',
  importData: 'Daten importieren',
  resetData: 'Alle Daten löschen',
  resetConfirm: 'Damit wird alles auf diesem Gerät gelöscht. Fortfahren?',
} as const satisfies Shape<typeof en>
