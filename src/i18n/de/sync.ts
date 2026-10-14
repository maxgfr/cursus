import type { sync as en } from '../en/sync.ts'
import type { Shape } from '../index.ts'

export const sync = {
  destinations: 'Speicherorte',
  addDestination: 'Speicherort hinzufügen',
  s3: 'S3-kompatibler Speicher',
  googleDrive: 'Google Drive',
  dropbox: 'Dropbox',
  icloud: 'iCloud Drive',
  cloudkit: 'CloudKit',
  folder: 'Ordner auf diesem Gerät',
  file: 'Backup-Datei',
  nearby: 'Gerät in der Nähe',
  protected: { one: 'An {count} Ort gesichert', other: 'An {count} Orten gesichert' },
  unprotected: 'Nur auf diesem Gerät',
  syncing: 'Wird synchronisiert …',
  synced: 'Auf dem neuesten Stand',
  lastSync: 'Zuletzt synchronisiert {time}',
  failed: 'Synchronisierung fehlgeschlagen',
  connect: 'Verbinden',
  disconnect: 'Trennen',
  pairDevice: 'Gerät koppeln',
  scanCode: 'Scanne den Code auf deinem anderen Gerät',
  passphrase: 'Verschlüsselungspasswort',
  passphraseHint: 'Damit liest du deine Daten auf einem neuen Gerät. Wir können es nicht wiederherstellen.',
  pending: { one: '{count} Änderung ausstehend', other: '{count} Änderungen ausstehend' },
} as const satisfies Shape<typeof en>
