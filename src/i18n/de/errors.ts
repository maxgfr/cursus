import type { errors as en } from '../en/errors.ts'
import type { Shape } from '../index.ts'

export const errors = {
  generic: 'Da ist etwas schiefgelaufen.',
  network: 'Keine Verbindung zum Netz. Prüfe deine Internetverbindung.',
  storageFull: 'Auf deinem Gerät ist kein Speicherplatz mehr frei.',
  invalidKey: 'Dieser API-Schlüssel wurde abgelehnt.',
  rateLimited: 'Zu viele Anfragen. Versuch es gleich noch einmal.',
  quotaExceeded: 'Dein KI-Kontingent ist aufgebraucht.',
  fileTooLarge: 'Diese Datei ist zu groß (max. {size}).',
  unsupportedFile: 'Dieser Dateityp wird nicht unterstützt.',
  wrongPassphrase: 'Falsches Passwort.',
  authExpired: 'Deine Anmeldung bei {provider} ist abgelaufen. Verbinde dich erneut.',
  conflict: 'Dieser Eintrag wurde auf einem anderen Gerät geändert.',
  corruptBackup: 'Dieses Backup ist beschädigt und kann nicht gelesen werden.',
  notFound: 'Nicht gefunden.',
} as const satisfies Shape<typeof en>
