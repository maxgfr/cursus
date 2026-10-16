import { useEffect, useState } from 'react'
import { useRuntime, useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { LocalStore } from '../../core/contracts/ports'
import type { Id } from '../../core/contracts/workspace'
import { queueLimitsFor, schedulerOf } from '../../core/model/reviewSettings'
import type { ModelWorkspace } from '../../core/model/workspace'
import {
  type CardState,
  dayStart,
  localOffset,
  type ReplaySnapshot,
  type Scheduler,
  studyDay,
} from '../../core/srs/fsrs'
import { nearestExam } from '../../core/srs/planner'
import { buildQueue } from '../../core/srs/queue'
import { REPLAYS_KEY } from '../../core/srs/savedReplays'
import { type CourseHue, courseHue } from '../components/Badges.tsx'

export interface CourseStudy {
  id: Id
  title: string
  hue: CourseHue
  /** Cards in today's queue for this course. */
  due: number
  total: number
  /** Earliest due time among its reviewed cards (null when none). */
  nextDue: number | null
}

export interface StudySummary {
  due: number
  newDue: number
  /** Estimated time for today's queue, from this student's own answer times. */
  estimateMs: number
  /** Queue size at the start of tomorrow's study day. */
  tomorrow: number
  totalCards: number
  courses: CourseStudy[]
  /** Cards in (re)learning that come due later in today's study day: they are not done yet. */
  later: { count: number; nextAt: number } | null
  /** The course whose exam comes first, with its share of today's queue. */
  exam: { courseId: Id; title: string; due: number; days: number } | null
}

/** Local noon of an ISO `YYYY-MM-DD` exam date (inside that study day whatever the zone); null when malformed. */
export function examTime(examDate: string | undefined): number | null {
  const m = examDate === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(examDate)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime()
}

/** The course with the nearest exam ahead: its cards lead today's session. */
export function examCourse(ws: ModelWorkspace, now: number): { id: Id; days: number } | null {
  const tzOffsetMin = localOffset(now)
  const candidates = []
  for (const c of ws.courses.list()) {
    const examAt = examTime(c.examDate)
    if (examAt !== null) candidates.push({ id: c.id, plan: { examAt, tzOffsetMin } })
  }
  return nearestExam(candidates, now)
}

// ---- Replays kept between launches ----
// The replica reads the replays an earlier launch saved before it is ready (see loadReplica): the first
// computation starts from them instead of racing their read and replaying the whole history.

const seeded = new WeakSet<Scheduler>()
function seedOnce(scheduler: Scheduler, saved: ReplaySnapshot | null): void {
  if (saved === null || seeded.has(scheduler)) return
  seeded.add(scheduler)
  scheduler.restore(saved)
}

let saveStore: LocalStore | null = null
let saveScheduler: Scheduler | null = null
let savedAt = 0
let everSaved = false
let saveTimer: ReturnType<typeof setTimeout> | undefined
/** Saves the replay cache after a computation that replayed anything: the first one right after the paint, later ones once quiet. */
function scheduleSave(): void {
  clearTimeout(saveTimer)
  const wait = everSaved ? 2_000 : 0
  saveTimer = setTimeout(() => {
    const store = saveStore
    const scheduler = saveScheduler
    if (store === null || scheduler === null || scheduler.replays === savedAt) return
    savedAt = scheduler.replays
    everSaved = true
    store
      .commit([{ put: 'kv', key: REPLAYS_KEY, value: scheduler.snapshot() }])
      .catch((e: unknown) => console.error('replays not saved', e))
  }, wait)
}

/** Default seconds per card until the student has a few reviews of their own. */
const FALLBACK_MS = 10_000

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

/** Today's summary; `saved` (the replays an earlier launch saved) seeds the scheduler before anything replays. */
export function computeStudy(ws: ModelWorkspace, now: number, saved: ReplaySnapshot | null = null): StudySummary {
  const tz = localOffset(now)
  const courses = ws.courses.list()
  const live = new Set(courses.map((c) => c.id))
  const cards = ws.cards.list().filter((c) => live.has(c.courseId) && !c.suspended)
  const scheduler = schedulerOf(ws)
  seedOnce(scheduler, saved)
  saveScheduler = scheduler
  const states = new Map<Id, CardState>()
  const times: number[] = []
  for (const c of cards) {
    const events = ws.reviews.forCard(c.id)
    if (events.length === 0) continue
    states.set(c.id, scheduler.replay(c.id, events))
    for (const e of events) if ('ms' in e && e.ms > 0) times.push(e.ms)
  }
  const input = { cards: cards.map((c) => ({ id: c.id })), states, tzOffsetMin: tz, ...queueLimitsFor(ws) }
  const queue = buildQueue({ ...input, now })
  const tomorrow = buildQueue({ ...input, now: dayStart(studyDay(now, tz) + 1, tz) })

  const courseOf = new Map(cards.map((c) => [c.id, c.courseId]))
  const dueBy = new Map<Id, number>()
  for (const q of queue) {
    const cid = courseOf.get(q.cardId)
    if (cid !== undefined) dueBy.set(cid, (dueBy.get(cid) ?? 0) + 1)
  }
  const totalBy = new Map<Id, number>()
  const nextBy = new Map<Id, number>()
  for (const c of cards) {
    totalBy.set(c.courseId, (totalBy.get(c.courseId) ?? 0) + 1)
    const s = states.get(c.id)
    if (s && s.phase !== 'new') nextBy.set(c.courseId, Math.min(nextBy.get(c.courseId) ?? s.due, s.due))
  }
  const endOfDay = dayStart(studyDay(now, tz) + 1, tz)
  let laterCount = 0
  let nextAt = Number.POSITIVE_INFINITY
  for (const s of states.values()) {
    if ((s.phase === 'learning' || s.phase === 'relearning') && s.due > now && s.due < endOfDay) {
      laterCount++
      nextAt = Math.min(nextAt, s.due)
    }
  }
  const nearest = examCourse(ws, now)
  const examTitle = nearest === null ? undefined : courses.find((c) => c.id === nearest.id)?.title
  const perCard = Math.min(60_000, Math.max(3_000, median(times.slice(-200)) ?? FALLBACK_MS))
  const list: CourseStudy[] = courses.map((c) => ({
    id: c.id,
    title: c.title,
    hue: courseHue(c.color, c.id),
    due: dueBy.get(c.id) ?? 0,
    total: totalBy.get(c.id) ?? 0,
    nextDue: nextBy.get(c.id) ?? null,
  }))
  // Most urgent first: due today, then soonest due, then the student's own order.
  const order = new Map(courses.map((c, i) => [c.id, i]))
  list.sort(
    (a, b) =>
      Number(b.due > 0) - Number(a.due > 0) ||
      (a.nextDue ?? Number.POSITIVE_INFINITY) - (b.nextDue ?? Number.POSITIVE_INFINITY) ||
      (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  )
  return {
    due: queue.length,
    newDue: queue.filter((q) => q.kind === 'new').length,
    estimateMs: queue.length * perCard,
    tomorrow: tomorrow.length,
    totalCards: cards.length,
    courses: list,
    later: laterCount > 0 ? { count: laterCount, nextAt } : null,
    exam:
      nearest === null || examTitle === undefined
        ? null
        : { courseId: nearest.id, title: examTitle, due: dueBy.get(nearest.id) ?? 0, days: nearest.days },
  }
}

const SCOPES = ['courses', 'sections', 'cards', 'reviews', 'prefs'] as const

/** Per workspace: a change counter over SCOPES, and the last summary computed at that count. */
interface Shared {
  version: number
  last?: { version: number; minute: number; value: StudySummary }
}
const shared = new WeakMap<ModelWorkspace, Shared>()

/**
 * One computation serves every component on screen (shell, Today, course rows): replaying a large history
 * is the costly part of a launch. Recomputed when the data changes, and at least once a minute.
 */
function sharedStudy(ws: ModelWorkspace, now: number, saved: ReplaySnapshot | null): StudySummary {
  let entry = shared.get(ws)
  if (!entry) {
    const created: Shared = { version: 0 }
    for (const scope of SCOPES)
      ws.subscribe(scope, () => {
        created.version++
      })
    shared.set(ws, created)
    entry = created
  }
  const minute = Math.floor(now / 60_000)
  const last = entry.last
  if (last && last.version === entry.version && last.minute === minute) return last.value
  const value = computeStudy(ws, now, saved)
  scheduleSave()
  entry.last = { version: entry.version, minute, value }
  return value
}

/** Today's study summary, recomputed whenever courses, sections, cards, reviews or prefs change. */
export function useStudy(): StudySummary {
  const rt = useRuntime()
  saveStore = rt.store
  const ws = useWorkspace()
  // Re-renders on a new minute and when the data changes; the summary is shared and cached per minute.
  useMinute()
  useWorkspaceData(SCOPES, () => ({}))
  return sharedStudy(ws, Date.now(), rt.replays)
}

/**
 * The current time, refreshed on each new minute and when the app comes back to the foreground, so
 * cards that come due (a learning step, tomorrow's reviews after 04:00) show up without a reload.
 */
export function useMinute(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      clearTimeout(timer)
      const at = Date.now()
      setNow(at)
      timer = setTimeout(tick, 60_000 - (at % 60_000) + 50)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return now
}
