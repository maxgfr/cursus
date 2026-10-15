import { useMemo } from 'react'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id, SessionKind, SessionScope } from '../../core/contracts/workspace'
import { sessionQueue } from '../../core/model/sessions'
import type { ModelWorkspace } from '../../core/model/workspace'
import { practiceByDefault } from '../Sessions/describe.ts'

/** What the session form edits; `limit` stays text until it is checked. */
export interface SessionDraft {
  scope: SessionScope
  kind: SessionKind
  limit: string
  /** Every matching card, with no limit: `limit` is then kept for when it is turned off. */
  every: boolean
  practice: boolean
  /** The student set "Count toward the schedule" themselves: changing the type no longer resets it. */
  practiceSet: boolean
}

export const DEFAULT_LIMIT = 20
const MAX_LIMIT = 999

export function newDraft(scope: SessionScope, kind: SessionKind = 'due'): SessionDraft {
  return {
    scope,
    kind,
    limit: String(DEFAULT_LIMIT),
    every: false,
    practice: practiceByDefault(kind),
    practiceSet: false,
  }
}

/** The draft with another type: "Count toward the schedule" follows the type until the student sets it. */
export function withKind(d: SessionDraft, kind: SessionKind): SessionDraft {
  return { ...d, kind, practice: d.practiceSet ? d.practice : practiceByDefault(kind) }
}

/** The card count as a number, or null when it is not a whole number from 1 to 999. */
export function parseLimit(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const n = Number(text.trim())
  return n >= 1 && n <= MAX_LIMIT ? n : null
}

/** The draft's card limit: undefined for every matching card, null while the count is invalid. */
export function draftLimit(d: SessionDraft): number | undefined | null {
  return d.every ? undefined : parseLimit(d.limit)
}

export interface ScopeOption {
  value: string
  label: string
  scope: SessionScope
}

/** Every course, each followed by its live subsets in tree order ("Law › Contracts"). Every course at once is `''`. */
export function scopeOptions(ws: ModelWorkspace): ScopeOption[] {
  const out: ScopeOption[] = []
  const tree = ws.sections.tree()
  for (const c of ws.courses.list()) {
    out.push({ value: `c:${c.id}`, label: c.title, scope: { courseId: c.id } })
    const walk = (parent: Id | null, path: string) => {
      for (const s of tree.children(c.id, parent)) {
        if (tree.hidden(s.id)) continue
        const label = `${path} › ${s.name}`
        out.push({ value: `s:${s.id}`, label, scope: { courseId: c.id, sectionId: s.id } })
        walk(s.id, label)
      }
    }
    walk(null, c.title)
  }
  return out
}

export const scopeValue = (s: SessionScope): string =>
  s.sectionId !== undefined ? `s:${s.sectionId}` : s.courseId !== undefined ? `c:${s.courseId}` : ''

/** A scope that still exists (a course or subset trashed since falls back to every course). */
export function liveScope(options: readonly ScopeOption[], s: SessionScope): SessionScope {
  return options.find((o) => o.value === scopeValue(s))?.scope ?? {}
}

/** How many cards the session would hold if it started now; null while the count is invalid. */
export function useSessionPreview(d: SessionDraft): number | null {
  // A fresh snapshot whenever the cards, their reviews or the settings change: the preview follows them live.
  const live = useWorkspaceData(['cards', 'courses', 'sections', 'reviews', 'prefs'], (ws) => ({ ws }))
  const limit = draftLimit(d)
  const { courseId, sectionId } = d.scope
  return useMemo(() => {
    if (limit === null) return null
    const scope: SessionScope = {}
    if (courseId !== undefined) scope.courseId = courseId
    if (sectionId !== undefined) scope.sectionId = sectionId
    return sessionQueue(live.ws, { scope, kind: d.kind, limit, practice: d.practice, now: Date.now() }).length
  }, [live, courseId, sectionId, d.kind, limit, d.practice])
}
