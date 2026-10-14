/** Hash routes (GitHub Pages has no SPA rewrite). One pattern per screen; builders for links. */
export const paths = {
  today: '/',
  courses: '/courses',
  course: '/course/:id',
  section: '/course/:id/s/:sectionId',
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
  section: (courseId: string, sectionId: string) =>
    `/course/${encodeURIComponent(courseId)}/s/${encodeURIComponent(sectionId)}`,
  /** A course root, or one of its subsets. */
  place: (courseId: string, sectionId?: string | null) =>
    sectionId
      ? `/course/${encodeURIComponent(courseId)}/s/${encodeURIComponent(sectionId)}`
      : `/course/${encodeURIComponent(courseId)}`,
  source: (id: string) => `/source/${encodeURIComponent(id)}`,
  card: (id: string) => `/card/${encodeURIComponent(id)}`,
  history: (id: string) => `/history/${encodeURIComponent(id)}`,
} as const

/** A study scope carried in the query (`?course=…&section=…`): read once by the screen, then dropped. */
export function withScope(path: string, scope: { courseId: string; sectionId?: string } | null): string {
  if (scope === null) return path
  const q = new URLSearchParams({ course: scope.courseId })
  if (scope.sectionId) q.set('section', scope.sectionId)
  return `${path}?${q.toString()}`
}

/** The scope a query carries, if any. */
export function scopeFrom(search: string): { courseId: string; sectionId?: string } | null {
  const q = new URLSearchParams(search)
  const courseId = q.get('course')
  if (!courseId) return null
  const sectionId = q.get('section')
  return sectionId ? { courseId, sectionId } : { courseId }
}

/** Focus routes hide the navigation chrome (tab bar / sidebar). */
export function isFocusRoute(location: string): boolean {
  return location === paths.review || location === paths.onboarding
}
