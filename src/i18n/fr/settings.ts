import type { settings as en } from '../en/settings.ts'
import type { Shape } from '../index.ts'

export const settings = {
  title: 'Réglages',
  language: 'Langue',
  languageAuto: 'Langue de l’appareil',
  theme: 'Apparence',
  themeSystem: 'Système',
  themeLight: 'Clair',
  themeDark: 'Sombre',
  apiKey: 'Clé d’API',
  apiKeyHint: 'Votre clé reste sur vos appareils.',
  dailyNew: 'Nouvelles cartes par jour',
  dailyMax: 'Révisions maximum par jour',
  retention: 'Taux de rétention visé',
  sync: 'Synchronisation et sauvegarde',
  about: 'À propos',
  version: 'Version {version}',
  exportData: 'Exporter les données',
  importData: 'Importer des données',
  resetData: 'Effacer toutes les données',
  resetConfirm: 'Tout sera effacé de cet appareil. Continuer ?',
} as const satisfies Shape<typeof en>
