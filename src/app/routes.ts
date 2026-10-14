/** Hash routes (GitHub Pages has no SPA rewrite). One pattern per screen; builders for links. */
export const paths = {
  today: '/',
  courses: '/courses',
  course: '/course/:id',
  source: '/source/:id',
  card: '/card/:id',
  trash: '/trash',
  history: '/history/:id',
  onboarding: '/onboarding',
  review: '/review',
  understand: '/understand',
  generate: '/generate',
  quiz: '/quiz',
  stats: '/stats',
  search: '/search',
  settings: '/settings',
  settingsGeneral: '/settings/general',
  settingsReview: '/settings/review',
  settingsAi: '/settings/ai',
  settingsSync: '/settings/sync',
  settingsSeal: '/settings/seal',
  settingsPair: '/settings/pair',
  settingsData: '/settings/data',
  settingsRecovery: '/settings/recovery',
  settingsDiagnostic: '/settings/diagnostic',
} as const

export type RouteName = keyof typeof paths

export const to = {
  course: (id: string) => `/course/${encodeURIComponent(id)}`,
  source: (id: string) => `/source/${encodeURIComponent(id)}`,
  card: (id: string) => `/card/${encodeURIComponent(id)}`,
  history: (id: string) => `/history/${encodeURIComponent(id)}`,
} as const

/** Focus routes hide the navigation chrome (tab bar / sidebar). */
export function isFocusRoute(location: string): boolean {
  return location === paths.review || location === paths.onboarding
}
