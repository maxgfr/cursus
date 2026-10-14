import type { today as en } from '../en/today.ts'
import type { Shape } from '../index.ts'

export const today = {
  title: 'Heute',
  greeting: 'Schön, dass du da bist',
  due: { one: '{count} Karte fällig', other: '{count} Karten fällig' },
  newCards: { one: '{count} neue Karte', other: '{count} neue Karten' },
  start: 'Lernen starten',
  allDone: 'Für heute alles erledigt. Bis morgen!',
  courses: 'Kurse',
  addCourse: 'Neuer Kurs',
  noCourses: 'Noch keine Kurse. Leg einen an, um loszulegen.',
  streak: { one: '{count} Tag in Folge', other: '{count} Tage in Folge' },
  examIn: { one: 'Prüfung in {count} Tag', other: 'Prüfung in {count} Tagen' },
  examCountdown: 'T-{count}',
  examToday: 'Prüfung heute',
  setupLink: 'Neu hier? Cursus einrichten',
  installTitle: 'Installiere Cursus zuerst',
  installed: 'Cursus läuft als installierte App.',
  installBody:
    'Füge Cursus vor dem Start zum Home-Bildschirm oder Dock hinzu. Auf iPhone und iPad führen ein Safari-Tab und die installierte App getrennte Kopien deiner Bibliothek.',
  safariTabTitle: 'Du bist in einem Safari-Tab.',
  safariTabBody:
    'Was du hier hinzufügst, bleibt in diesem Tab und nicht in der installierten App. Installiere zuerst: Teilen, dann Zum Home-Bildschirm (oder Zum Dock hinzufügen auf dem Mac).',
  storageTitle: 'Speicher auf diesem Gerät',
  storageKept: 'Bei Speichermangel behalten',
  storagePersisted: 'Ja, dauerhaft',
  storageBestEffort: 'Nach Möglichkeit',
  storageUsed: 'Belegter Speicher',
  storageUnknown: 'Von diesem Browser nicht angegeben',
  storageUsage: '{used} von {quota} ({percent})',
  storageHint:
    'Ohne dauerhaften Speicher kann der Browser deine Bibliothek bei Platzmangel löschen. Richte zusätzlich ein Sync-Ziel ein.',
  storageAsk: 'Daten dauerhaft behalten',
  demoTitle: 'Mit einem Demokurs ausprobieren',
  demoBody:
    'Fügt einen kleinen Kurs mit einer Notiz und drei Karten hinzu, damit du eine Wiederholung siehst, bevor du eigene anlegst. Jederzeit löschbar.',
  demoAction: 'Demokurs ausprobieren',
  demoCourse: 'Demo: Zellbiologie',
  demoNoteTitle: 'Die Zelle in fünf Zeilen',
  demoNoteBody:
    '# Die Zelle\n\n- Der **Zellkern** enthält die DNA.\n- **Mitochondrien** erzeugen den Großteil des ATP.\n- **Ribosomen** bauen Proteine.\n- Die **Zellmembran** regelt, was hinein- und hinausgeht.\n',
  demoQ1: 'Welches Organell erzeugt den Großteil des ATP der Zelle?',
  demoA1: 'Die Mitochondrien.',
  demoQ2: 'Was bauen Ribosomen?',
  demoA2: 'Proteine.',
  demoCloze: 'Der {{c1::Zellkern}} enthält die {{c2::DNA}} der Zelle.',
} as const satisfies Shape<typeof en>
