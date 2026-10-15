import type * as Y from 'yjs'
import type { Clock, Rng } from '../contracts/ports'
import type { Id, NewSession, Session, SessionKind, SessionScope } from '../contracts/workspace'
import { SESSION_KINDS } from '../srs/sessionKinds'
import { EntityNotFoundError, EntityRepo, type RepoDeps } from './repos'
import {
  type PlanFields,
  type PlanRecord,
  ROOT,
  type SessionEndEvent,
  type SessionEvent,
  type SessionStartEvent,
} from './schema'

/*
 * What the workspace holds of sessions: the session log and the planned sessions, with the checks on every
 * write. The rest (queues, summaries, next occurrences) is in sessions.ts, which only screens load.
 */

export class SessionInputError extends RangeError {
  constructor(m: string) {
    super(m)
    this.name = 'SessionInputError'
  }
}

function checkKind(kind: SessionKind): void {
  if (!SESSION_KINDS.includes(kind)) throw new SessionInputError(`unknown session kind ${String(kind)}`)
}

function checkLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new SessionInputError(`invalid session limit ${limit}`)
}

function checkTime(at: number | undefined): void {
  if (at !== undefined && !Number.isFinite(at)) throw new SessionInputError(`invalid time ${at}`)
}

/** Only the keys that are set: the log never holds `undefined`. */
export function cleanScope(scope: SessionScope): SessionScope {
  const out: SessionScope = {}
  if (scope.courseId !== undefined) out.courseId = scope.courseId
  if (scope.sectionId !== undefined) out.sectionId = scope.sectionId
  return out
}

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const isEnd = (e: SessionEvent): e is SessionEndEvent => 'ends' in e

/**
 * The session log, a top-level Y.Array of events: a session starts with one event and ends with another appended
 * later, never with a rewrite. Ends from several devices merge: the earliest one wins.
 */
export class SessionLog {
  private readonly arr: Y.Array<SessionEvent>
  private cache: { list: readonly Session[]; byId: Map<Id, Session> } | null = null

  constructor(
    doc: Y.Doc,
    private readonly rng: Rng,
    private readonly clock: Clock,
    private readonly dev: string,
  ) {
    this.arr = doc.getArray<SessionEvent>(ROOT.sessions)
    this.arr.observe(() => {
      this.cache = null
    })
  }

  get yArray(): Y.Array<SessionEvent> {
    return this.arr
  }

  /** Starts a session now, or at `at` (a session that already took place: the demo course's), and returns its id. */
  start(s: NewSession, at?: number): Id {
    checkKind(s.kind)
    checkLimit(s.limit)
    checkTime(at)
    const e: SessionStartEvent = {
      id: this.rng.id(),
      startedAt: at ?? this.clock.now(),
      dev: this.dev,
      scope: cleanScope(s.scope),
      kind: s.kind,
      practice: s.practice === true,
    }
    if (s.limit !== undefined) e.limit = s.limit
    if (s.planId !== undefined) e.planId = s.planId
    if (s.cardIds !== undefined) e.cardIds = [...s.cardIds]
    this.arr.push([e])
    this.cache = null
    return e.id
  }

  /** Ends a session now, or at `at` (never before it started); ending it again does nothing. */
  end(id: Id, at?: number): void {
    checkTime(at)
    const s = this.get(id)
    if (!s) throw new EntityNotFoundError('sessions', id)
    if (s.endedAt !== undefined) return
    this.arr.push([{ id: this.rng.id(), ends: id, endedAt: Math.max(at ?? this.clock.now(), s.startedAt) }])
    this.cache = null
  }

  private derive(): { list: readonly Session[]; byId: Map<Id, Session> } {
    if (this.cache) return this.cache
    const events = this.arr.toArray()
    const ends = new Map<Id, number>()
    for (const e of events) if (isEnd(e)) ends.set(e.ends, Math.min(ends.get(e.ends) ?? e.endedAt, e.endedAt))
    const list: Session[] = []
    for (const e of events) {
      if (isEnd(e)) continue
      const s: Session = { id: e.id, startedAt: e.startedAt, scope: { ...e.scope }, kind: e.kind, practice: e.practice }
      if (e.limit !== undefined) s.limit = e.limit
      if (e.planId !== undefined) s.planId = e.planId
      if (e.cardIds !== undefined) s.cardIds = [...e.cardIds]
      const end = ends.get(e.id)
      if (end !== undefined) s.endedAt = end
      list.push(s)
    }
    list.sort((a, b) => b.startedAt - a.startedAt || cmp(b.id, a.id))
    this.cache = { list, byId: new Map(list.map((s) => [s.id, s])) }
    return this.cache
  }

  /** Every session, newest first. */
  list(): readonly Session[] {
    return this.derive().list
  }

  get(id: Id): Session | undefined {
    return this.derive().byId.get(id)
  }
}

// ---- Planned sessions ----

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Hours and minutes of an `HH:MM` time. */
export function parseTime(time: string): { hour: number; minute: number } {
  const m = TIME.exec(time)
  if (!m) throw new SessionInputError(`invalid time ${time}`)
  return { hour: Number(m[1]), minute: Number(m[2]) }
}

const REQUIRED = ['name', 'kind', 'weekdays', 'time', 'practice'] as const

/** Checks the fields a write sets (all required ones on creation); weekdays come back sorted and unique. */
function checkPlan<P extends Partial<PlanFields>>(p: P, creating: boolean): P {
  for (const k of REQUIRED)
    if ((creating || k in p) && p[k] === undefined) throw new SessionInputError(`a planned session needs ${k}`)
  if (p.name !== undefined && p.name.trim() === '') throw new SessionInputError('a planned session needs a name')
  if (p.kind !== undefined) checkKind(p.kind)
  checkLimit(p.limit)
  if (p.time !== undefined) parseTime(p.time)
  if (p.weekdays === undefined) return p
  const days = [...new Set(p.weekdays)].sort((a, b) => a - b)
  if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    throw new SessionInputError(`invalid weekdays ${p.weekdays.join(',')}`)
  return { ...p, weekdays: days }
}

/** Planned sessions: a top-level collection of Y.Maps of scalars, checked on every write. */
export class PlanRepo extends EntityRepo<PlanRecord, PlanFields> {
  constructor(deps: RepoDeps) {
    super(deps, 'plans')
  }

  override create(i: PlanFields): Id {
    return super.create(checkPlan(i, true))
  }

  /** Only the fields given are checked: another device may be changing the others at the same time. */
  override update(id: Id, p: Partial<PlanFields>): void {
    super.update(id, checkPlan(p, false))
  }
}
