import type { sync as en } from '../en/sync.ts'
import type { Shape } from '../index.ts'

export const sync = {
  destinations: 'Destinations',
  addDestination: 'Ajouter une destination',
  s3: 'Stockage compatible S3',
  googleDrive: 'Google Drive',
  dropbox: 'Dropbox',
  icloud: 'iCloud Drive',
  cloudkit: 'CloudKit',
  folder: 'Dossier sur cet appareil',
  file: 'Fichier de sauvegarde',
  nearby: 'Appareil à proximité',
  protected: { one: 'Protégé sur {count} destination', other: 'Protégé sur {count} destinations' },
  unprotected: 'Uniquement sur cet appareil',
  syncing: 'Synchronisation…',
  synced: 'À jour',
  lastSync: 'Dernière synchronisation {time}',
  failed: 'Échec de la synchronisation',
  connect: 'Connecter',
  disconnect: 'Déconnecter',
  pairDevice: 'Associer un appareil',
  scanCode: 'Scannez le code affiché sur votre autre appareil',
  passphrase: 'Phrase secrète de chiffrement',
  passphraseHint: 'Indispensable pour lire vos données sur un nouvel appareil. Nous ne pouvons pas la récupérer.',
  pending: { one: '{count} modification en attente', other: '{count} modifications en attente' },
} as const satisfies Shape<typeof en>
