import { paths } from '../../app/routes.ts'

/** Screens reached from a course: going back to them from the course would loop. */
const CHILD = /^\/(card|source|history|course)\//

/**
 * Where the course's Back goes: the nearest earlier in-app screen that is not one of the course's own children
 * (Today, Courses, Stats, Search…), else Courses.
 */
export function backTarget(earlier: readonly string[]): string {
  for (let i = earlier.length - 1; i >= 0; i--) {
    const path = earlier[i] ?? ''
    if (!CHILD.test(path)) return path
  }
  return paths.courses
}

interface NavEntry {
  url: string | null
}
interface NavigationLike {
  entries(): NavEntry[]
  currentEntry: { index: number } | null
}

/** Hash paths of this tab's earlier history entries in this app, oldest first (empty where the browser can't tell). */
export function earlierPaths(): string[] {
  const nav = (globalThis as { navigation?: NavigationLike }).navigation
  if (!nav?.currentEntry) return []
  const here = new URL(location.href)
  const out: string[] = []
  for (const e of nav.entries().slice(0, nav.currentEntry.index)) {
    if (!e.url) continue
    const u = new URL(e.url)
    if (u.origin !== here.origin || u.pathname !== here.pathname) {
      out.length = 0
      continue
    }
    out.push(`/${u.hash.replace(/^#?\/?/, '')}`.replace(/\?.*$/, ''))
  }
  return out
}
