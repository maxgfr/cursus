import type { errors as en } from '../en/errors.ts'
import type { Shape } from '../index.ts'

export const errors = {
  generic: 'Une erreur s’est produite.',
  network: 'Réseau injoignable. Vérifiez votre connexion.',
  storageFull: 'L’espace de stockage de votre appareil est plein.',
  invalidKey: 'Cette clé d’API a été refusée.',
  rateLimited: 'Trop de requêtes. Réessayez dans un instant.',
  quotaExceeded: 'Votre quota d’IA est épuisé.',
  fileTooLarge: 'Ce fichier est trop volumineux ({size} maximum).',
  unsupportedFile: 'Ce type de fichier n’est pas pris en charge.',
  wrongPassphrase: 'Phrase secrète incorrecte.',
  authExpired: 'Votre connexion à {provider} a expiré. Reconnectez-la.',
  conflict: 'Cet élément a été modifié sur un autre appareil.',
  corruptBackup: 'Cette sauvegarde est endommagée et illisible.',
  notFound: 'Introuvable.',
  storageFullNext: 'Libérez de l’espace sur cet appareil, puis réessayez. Rien n’a été perdu.',
  networkNext: 'Vérifiez votre connexion, puis réessayez.',
  invalidKeyNext: 'Vérifiez la clé dans Réglages, IA.',
  rateLimitedNext: 'Attendez une minute, puis réessayez.',
  quotaExceededNext: 'Rechargez votre crédit chez votre fournisseur d’IA, ou changez de modèle dans Réglages, IA.',
  genericNext: 'Réessayez. Si cela continue, rechargez Cursus : vos réponses jusqu’ici sont enregistrées.',
} as const satisfies Shape<typeof en>
