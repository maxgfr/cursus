import type { common as en } from '../en/common.ts'
import type { Shape } from '../index.ts'

export const common = {
  appName: 'Cursus',
  save: 'Enregistrer',
  cancel: 'Annuler',
  delete: 'Supprimer',
  edit: 'Modifier',
  close: 'Fermer',
  back: 'Retour',
  done: 'Terminé',
  retry: 'Réessayer',
  loading: 'Chargement…',
  search: 'Rechercher',
  confirm: 'Confirmer',
  undo: 'Annuler l’action',
  more: 'Plus',
  today: 'Aujourd’hui',
  settings: 'Réglages',
  offline: 'Vous êtes hors ligne. Vos modifications sont enregistrées sur cet appareil.',
  items: { one: '{count} élément', other: '{count} éléments' },
} as const satisfies Shape<typeof en>
