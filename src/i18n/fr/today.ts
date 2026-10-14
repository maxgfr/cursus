import type { today as en } from '../en/today.ts'
import type { Shape } from '../index.ts'

export const today = {
  title: 'Aujourd’hui',
  greeting: 'Content de vous revoir',
  due: { one: '{count} carte à revoir', other: '{count} cartes à revoir' },
  newCards: { one: '{count} nouvelle carte', other: '{count} nouvelles cartes' },
  start: 'Commencer la révision',
  allDone: 'Tout est fait pour aujourd’hui. À demain !',
  courses: 'Cours',
  addCourse: 'Nouveau cours',
  noCourses: 'Aucun cours pour l’instant. Créez-en un pour commencer.',
  streak: { one: '{count} jour d’affilée', other: '{count} jours d’affilée' },
  examIn: { one: 'Examen dans {count} jour', other: 'Examen dans {count} jours' },
  examCountdown: 'J-{count}',
  examToday: 'Examen aujourd’hui',
  setupLink: 'Première fois ? Configurer Cursus',
  installTitle: 'Installe Cursus d’abord',
  installed: 'Cursus tourne en app installée.',
  installBody:
    'Ajoute Cursus à l’écran d’accueil ou au Dock avant de commencer. Sur iPhone et iPad, un onglet Safari et l’app installée gardent chacun leur propre copie de ta bibliothèque.',
  safariTabTitle: 'Tu es dans un onglet Safari.',
  safariTabBody:
    'Ce que tu ajoutes ici reste dans cet onglet, pas dans l’app installée. Installe d’abord : Partager, puis Sur l’écran d’accueil (ou Ajouter au Dock sur Mac).',
  storageTitle: 'Stockage sur cet appareil',
  storageKept: 'Conservé si l’espace manque',
  storagePersisted: 'Oui, persistant',
  storageBestEffort: 'Au mieux',
  storageUsed: 'Espace utilisé',
  storageUnknown: 'Non indiqué par ce navigateur',
  storageUsage: '{used} sur {quota} ({percent})',
  storageHint:
    'Sans stockage persistant, le navigateur peut effacer ta bibliothèque quand l’espace manque. Ajoute aussi une destination de sync.',
  storageAsk: 'Demander à garder mes données',
  demoTitle: 'Essayer avec un cours de démo',
  demoBody:
    'Ajoute un petit cours avec une note et trois cartes, pour voir une révision avant d’ajouter les tiens. Supprimable à tout moment.',
  demoAction: 'Essayer un cours de démo',
  demoCourse: 'Démo : biologie cellulaire',
  demoNoteTitle: 'La cellule en cinq lignes',
  demoNoteBody:
    '# La cellule\n\n- Le **noyau** contient l’ADN.\n- Les **mitochondries** produisent l’essentiel de l’ATP.\n- Les **ribosomes** fabriquent les protéines.\n- La **membrane** contrôle ce qui entre et sort.\n',
  demoQ1: 'Quel organite produit l’essentiel de l’ATP de la cellule ?',
  demoA1: 'Les mitochondries.',
  demoQ2: 'Que fabriquent les ribosomes ?',
  demoA2: 'Des protéines.',
  demoCloze: 'Le {{c1::noyau}} contient l’{{c2::ADN}} de la cellule.',
} as const satisfies Shape<typeof en>
