import { type ComponentType, type ReactNode, Suspense } from 'react'
import { Route, Router, Switch } from 'wouter'
import Today from '../screens/Today/index.tsx'
import { lazyChunk } from './lazyChunk.tsx'
import { useNavLocation, useNavSearch } from './nav.ts'
import { paths, type RouteName } from './routes.ts'

type Screen = ComponentType

/**
 * One lazily loaded module per screen: P6 screens grow without touching the first paint. A screen whose chunk
 * fails to load says so calmly, with a retry.
 */
const screens: Record<Exclude<RouteName, 'today'>, Screen> = {
  courses: lazyChunk('courses', () => import('../screens/Courses/index.tsx')),
  course: lazyChunk('course', () => import('../screens/Course/index.tsx')),
  section: lazyChunk('section', () => import('../screens/Section/index.tsx')),
  source: lazyChunk('source', () => import('../screens/Source/index.tsx')),
  deckQuestions: lazyChunk('deckQuestions', () => import('../screens/Generate/DeckQuestions.tsx')),
  deckImport: lazyChunk('deckImport', () => import('../screens/DeckImport/index.tsx')),
  photos: lazyChunk('photos', () => import('../screens/Photos/index.tsx')),
  sectionPhotos: lazyChunk('photos', () => import('../screens/Photos/index.tsx')),
  photo: lazyChunk('photo', () => import('../screens/PhotoViewer/index.tsx')),
  fiche: lazyChunk('fiche', () => import('../screens/Fiche/index.tsx')),
  inbox: lazyChunk('inbox', () => import('../screens/Inbox/index.tsx')),
  card: lazyChunk('card', () => import('../screens/CardEditor/index.tsx')),
  trash: lazyChunk('trash', () => import('../screens/Trash/index.tsx')),
  history: lazyChunk('history', () => import('../screens/History/index.tsx')),
  onboarding: lazyChunk('onboarding', () => import('../screens/Onboarding/index.tsx')),
  review: lazyChunk('review', () => import('../screens/Review/index.tsx')),
  // Former screens of their own, now actions of the chat: the routes open it on them.
  understand: lazyChunk('understand', () =>
    import('../screens/ChatRoute/index.tsx').then((m) => ({ default: m.Understand })),
  ),
  generate: lazyChunk('generate', () =>
    import('../screens/ChatRoute/index.tsx').then((m) => ({ default: m.Generate })),
  ),
  quiz: lazyChunk('quiz', () => import('../screens/Quiz/index.tsx')),
  stats: lazyChunk('stats', () => import('../screens/Stats/index.tsx')),
  sessions: lazyChunk('sessions', () => import('../screens/Sessions/index.tsx')),
  sessionNew: lazyChunk('sessionNew', () => import('../screens/SessionSetup/index.tsx')),
  sessionPlan: lazyChunk('sessionPlan', () => import('../screens/SessionSetup/PlanEditor.tsx')),
  search: lazyChunk('search', () => import('../screens/Search/index.tsx')),
  settings: lazyChunk('settings', () => import('../screens/SettingsHome/index.tsx')),
  settingsGeneral: lazyChunk('settingsGeneral', () => import('../screens/settings/General/index.tsx')),
  settingsReview: lazyChunk('settingsReview', () => import('../screens/settings/ReviewPrefs/index.tsx')),
  settingsAi: lazyChunk('settingsAi', () => import('../screens/settings/Ai/index.tsx')),
  settingsSync: lazyChunk('settingsSync', () => import('../screens/settings/Sync/index.tsx')),
  settingsSeal: lazyChunk('settingsSeal', () => import('../screens/settings/Seal/index.tsx')),
  settingsPair: lazyChunk('settingsPair', () => import('../screens/settings/Pair/index.tsx')),
  settingsData: lazyChunk('settingsData', () => import('../screens/settings/Data/index.tsx')),
  settingsSecurity: lazyChunk('settingsSecurity', () => import('../screens/settings/Security/index.tsx')),
  settingsRecovery: lazyChunk('settingsRecovery', () => import('../screens/settings/Recovery/index.tsx')),
  settingsDiagnostic: lazyChunk('settingsDiagnostic', () => import('../screens/settings/Diagnostic/index.tsx')),
}

const NotFound = lazyChunk('notFound', () => import('../screens/NotFound/index.tsx'))

const entries = Object.entries(screens) as [keyof typeof screens, Screen][]

/** Hash routing (path and query in the hash): GitHub Pages serves one file and has no SPA rewrite. */
export function HashRouter({ children }: { children: ReactNode }) {
  return (
    <Router hook={useNavLocation} searchHook={useNavSearch}>
      {children}
    </Router>
  )
}

export function Routes() {
  return (
    <Suspense fallback={null}>
      <Switch>
        <Route path={paths.today} component={Today} />
        {entries.map(([name, Component]) => (
          <Route key={name} path={paths[name]} component={Component} />
        ))}
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  )
}
