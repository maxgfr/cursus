/** Hash routes (GitHub Pages has no SPA rewrite). One pattern per screen; builders for links. */
export const paths = {
  today: '/',
  courses: '/courses',
  course: '/course/:id',
  section: '/course/:id/s/:sectionId',
  source: '/source/:id',
  /** Questions made from a deck source (slides, a document), unit by unit. */
  deckQuestions: '/source/:id/questions',
  /** Import slides or a document (`?course=…&section=…`). */
  deckImport: '/import',
  photos: '/course/:id/photos',
  sectionPhotos: '/course/:id/s/:sectionId/photos',
  photo: '/photo/:id',
  /** « To review »: questions proposed on the documents added. */
  inbox: '/inbox',
  card: '/card/:id',
  trash: '/trash',
  history: '/history/:id',
  onboarding: '/onboarding',
  review: '/review',
  understand: '/understand',
  generate: '/generate',
  quiz: '/quiz',
  stats: '/stats',
  sessions: '/sessions',
  sessionNew: '/sessions/new',
  sessionPlan: '/sessions/plan/:id',
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
  deckQuestions: (id: string) => `/source/${encodeURIComponent(id)}/questions`,
  /** The photo gallery of a course root, or of one of its subsets (descendants included). */
  photos: (courseId: string, sectionId?: string | null) =>
    sectionId
      ? `/course/${encodeURIComponent(courseId)}/s/${encodeURIComponent(sectionId)}/photos`
      : `/course/${encodeURIComponent(courseId)}/photos`,
  photo: (id: string) => `/photo/${encodeURIComponent(id)}`,
  card: (id: string) => `/card/${encodeURIComponent(id)}`,
  history: (id: string) => `/history/${encodeURIComponent(id)}`,
  /** A planned session's editor; `new` creates one. */
  sessionPlan: (id: string) => `/sessions/plan/${encodeURIComponent(id)}`,
  /** The review focus view running a started session. */
  sessionRun: (sessionId: string) => `/review?${new URLSearchParams({ session: sessionId }).toString()}`,
} as const

/** The session a review was opened for (`?session=…`), if any. */
export function sessionFrom(search: string): string | null {
  return new URLSearchParams(search).get('session') || null
}

/** A study scope carried in the hash query (`?course=…&section=…`), kept by that history entry only. */
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
  // The photo viewer is full screen: the photo gets the whole width and height.
  return location === paths.review || location === paths.onboarding || location.startsWith('/photo/')
}
