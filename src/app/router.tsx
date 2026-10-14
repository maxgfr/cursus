import { type ComponentType, type LazyExoticComponent, lazy, type ReactNode, Suspense } from 'react'
import { Route, Router, Switch } from 'wouter'
import { useHashLocation } from 'wouter/use-hash-location'
import Today from '../screens/Today/index.tsx'
import { paths, type RouteName } from './routes.ts'

type Screen = LazyExoticComponent<ComponentType>

/** One lazily loaded module per screen: P6 screens grow without touching the first paint. */
const screens: Record<Exclude<RouteName, 'today'>, Screen> = {
  courses: lazy(() => import('../screens/Courses/index.tsx')),
  course: lazy(() => import('../screens/Course/index.tsx')),
  source: lazy(() => import('../screens/Source/index.tsx')),
  card: lazy(() => import('../screens/CardEditor/index.tsx')),
  trash: lazy(() => import('../screens/Trash/index.tsx')),
  history: lazy(() => import('../screens/History/index.tsx')),
  onboarding: lazy(() => import('../screens/Onboarding/index.tsx')),
  review: lazy(() => import('../screens/Review/index.tsx')),
  understand: lazy(() => import('../screens/Understand/index.tsx')),
  generate: lazy(() => import('../screens/Generate/index.tsx')),
  quiz: lazy(() => import('../screens/Quiz/index.tsx')),
  stats: lazy(() => import('../screens/Stats/index.tsx')),
  search: lazy(() => import('../screens/Search/index.tsx')),
  settings: lazy(() => import('../screens/SettingsHome/index.tsx')),
  settingsGeneral: lazy(() => import('../screens/settings/General/index.tsx')),
  settingsReview: lazy(() => import('../screens/settings/ReviewPrefs/index.tsx')),
  settingsAi: lazy(() => import('../screens/settings/Ai/index.tsx')),
  settingsSync: lazy(() => import('../screens/settings/Sync/index.tsx')),
  settingsSeal: lazy(() => import('../screens/settings/Seal/index.tsx')),
  settingsPair: lazy(() => import('../screens/settings/Pair/index.tsx')),
  settingsData: lazy(() => import('../screens/settings/Data/index.tsx')),
  settingsRecovery: lazy(() => import('../screens/settings/Recovery/index.tsx')),
  settingsDiagnostic: lazy(() => import('../screens/settings/Diagnostic/index.tsx')),
}

const NotFound = lazy(() => import('../screens/NotFound/index.tsx'))

const entries = Object.entries(screens) as [keyof typeof screens, Screen][]

/** Hash routing: GitHub Pages serves one file and has no SPA rewrite. */
export function HashRouter({ children }: { children: ReactNode }) {
  return <Router hook={useHashLocation}>{children}</Router>
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
