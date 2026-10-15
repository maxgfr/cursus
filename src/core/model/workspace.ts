import * as Y from 'yjs'
import type { Clock, Rng } from '../contracts/ports'
import type { Id, ItemKind, Prefs, Scope, StudyScope, Workspace } from '../contracts/workspace'
import { REMOTE } from '../log/origins'
import { type DeletionReport, deletionsBetween, track } from './deletions'
import { DraftRepo } from './drafts'
import { EntityNotFoundError, EntityRepo } from './repos'
import { AiUsageLog, ReviewLog } from './reviews'
import {
  type CardFields,
  type CardRecord,
  type CourseFields,
  type CourseRecord,
  type FicheFields,
  type FicheRecord,
  PREF_DEFAULTS,
  type RepoCollection,
  ROOT,
  type SectionRecord,
  type SourceFields,
  type SourceRecord,
  type TextField,
  textKey,
} from './schema'
import { SearchIndex } from './search'
import { SectionRepo } from './sections'
import { PlanRepo, SessionLog } from './sessionLog'
import { applyForward } from './textForward'

interface Observable {
  observeDeep(f: () => void): void
  unobserveDeep(f: () => void): void
}

export class TextNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`no text ${key}`)
    this.name = 'TextNotFoundError'
  }
}

export interface ModelWorkspace extends Workspace {
  readonly doc: Y.Doc
  courses: EntityRepo<CourseRecord, CourseFields>
  sources: EntityRepo<SourceRecord, SourceFields>
  fiches: EntityRepo<FicheRecord, FicheFields>
  cards: EntityRepo<CardRecord, CardFields> & { move(id: Id, courseId: Id): void }
  sections: SectionRepo
  /** Live entities of a course or subset (descendants included), those hidden in a trashed section excluded. */
  scoped<K extends ItemKind>(kind: K, scope: StudyScope): readonly ItemRecord[K][]
  /** Exam dates of live courses and their visible subsets: each course's own first, then its subsets in tree order. */
  exams(): readonly { scope: StudyScope; examDate: string }[]
  /**
   * Like `batch`, but all or nothing: if `fn` throws, its writes are undone (a forward inverse update, as
   * remote history keeps everything) and the error is rethrown. Nested in an open transaction it is a plain
   * batch: the outer one owns atomicity.
   */
  atomic<T>(fn: () => T): T
  reviews: ReviewLog
  aiUsage: AiUsageLog
  /** Study sessions: a log of start and end events. Their reviews carry the session id (`sid`). */
  sessions: SessionLog
  /** Planned, recurring sessions. */
  plans: PlanRepo
  /** Proposed questions awaiting review, and the « questions proposées automatiquement » settings. */
  drafts: DraftRepo
  search: SearchIndex
  /** What applying these remote updates would delete here, worked out on a scratch copy: the library is untouched. */
  previewRemote(updates: readonly Uint8Array[]): DeletionReport
  /**
   * Applies remote updates the sync guard held back, in order, as remote changes (never captured). With `keep`, then
   * writes in the same synchronous step, as local edits that sync out, a forward restoration of what they deleted:
   * entities they trashed, purged or removed are live again, texts they emptied are back to their content. Returns
   * what they deleted.
   */
  absorbHeld(updates: readonly Uint8Array[], mode: 'apply' | 'keep'): DeletionReport
  dispose(): void
}

export interface ItemRecord {
  sources: SourceRecord
  fiches: FicheRecord
  cards: CardRecord
}

export interface WorkspaceDeps {
  rng: Rng
  clock: Clock
  deviceId: string
}

/**
 * The only module touching Yjs. Construction performs no writes: defaults live
 * in code, and nothing is seeded.
 */
export function createWorkspace(doc: Y.Doc, deps: WorkspaceDeps): ModelWorkspace {
  const rd = { doc, rng: deps.rng, clock: deps.clock }
  const courses = new EntityRepo<CourseRecord, CourseFields>(rd, 'courses', true)
  const sources = new EntityRepo<SourceRecord, SourceFields>(rd, 'sources')
  const fiches = new EntityRepo<FicheRecord, FicheFields>(rd, 'fiches')
  const cardRepo = new EntityRepo<CardRecord, CardFields>(rd, 'cards')
  const sections = new SectionRepo(rd)
  // Moving a card to another course takes it out of its section there.
  const cards = Object.assign(cardRepo, {
    move(id: Id, courseId: Id): void {
      cardRepo.update(id, { courseId, sectionId: undefined })
    },
  })
  const items = { sources, fiches, cards: cardRepo }
  // An item inside a trashed section (or below one) is hidden by derivation: no cascade write.
  sources.hideWhen((e) => sections.tree().itemHidden(e))
  fiches.hideWhen((e) => sections.tree().itemHidden(e))
  cardRepo.hideWhen((e) => sections.tree().itemHidden(e))
  const reviews = new ReviewLog(doc, deps.rng, deps.deviceId)
  const aiUsage = new AiUsageLog(doc, deps.rng, deps.clock, deps.deviceId)
  const sessions = new SessionLog(doc, deps.rng, deps.clock, deps.deviceId)
  const plans = new PlanRepo(rd)
  const drafts = new DraftRepo(rd, {
    courses,
    sources,
    sections,
    cards: cardRepo,
    text: (ref) => text(ref),
    atomic: (fn) => api.atomic(fn),
  })
  const prefsMap = doc.getMap<unknown>(ROOT.prefs)
  const texts = doc.getMap<Y.Text>(ROOT.texts)
  const search = new SearchIndex(doc, () => sections.tree())
  const repos: Record<RepoCollection, { readonly yRoot: Y.Map<Y.Map<unknown>> }> = {
    courses,
    sections,
    sources,
    fiches,
    cards: cardRepo,
    plans,
    drafts,
  }

  function text(ref: { id: Id; field: TextField }): Y.Text {
    const key = textKey(ref.id, ref.field)
    const t = texts.get(key)
    if (!t) throw new TextNotFoundError(key)
    return t
  }

  function subscribe(scope: Scope, fn: () => void): () => void {
    const handler = () => fn()
    if (typeof scope === 'string') {
      const targets: readonly Observable[] =
        scope === 'reviews'
          ? reviews.yRoots
          : scope === 'sessions'
            ? [sessions.yArray]
            : scope === 'prefs'
              ? [prefsMap]
              : [repos[scope].yRoot]
      for (const t of targets) t.observeDeep(handler)
      return () => {
        for (const t of targets) t.unobserveDeep(handler)
      }
    }
    const targets: Observable[] = []
    for (const repo of Object.values(repos)) {
      const m = repo.yRoot.get(scope.id)
      if (m) targets.push(m)
    }
    for (const f of ['body', 'front', 'back'] as const) {
      const t = texts.get(textKey(scope.id, f))
      if (t) targets.push(t)
    }
    for (const t of targets) t.observeDeep(handler)
    return () => {
      for (const t of targets) t.unobserveDeep(handler)
    }
  }

  function moveItem(kind: ItemKind, id: Id, sectionId: Id | null): void {
    const repo: { update(id: Id, p: { courseId?: Id; sectionId?: Id }): void } = items[kind]
    if (sectionId === null) {
      repo.update(id, { sectionId: undefined })
      return
    }
    const target = sections.tree().get(sectionId)
    if (!target) throw new EntityNotFoundError('sections', sectionId)
    repo.update(id, { courseId: target.courseId, sectionId })
  }

  function scoped<K extends ItemKind>(kind: K, scope: StudyScope): readonly ItemRecord[K][] {
    const tree = sections.tree()
    const list = items[kind].list({ courseId: scope.courseId }) as readonly ItemRecord[K][]
    return scope.sectionId === undefined ? list : list.filter((e) => tree.contains(scope, e))
  }

  function exams(): readonly { scope: StudyScope; examDate: string }[] {
    const tree = sections.tree()
    const out: { scope: StudyScope; examDate: string }[] = []
    const visit = (s: SectionRecord): void => {
      if (s.examDate) out.push({ scope: { courseId: s.courseId, sectionId: s.id }, examDate: s.examDate })
      for (const c of tree.children(s.courseId, s.id)) visit(c)
    }
    for (const c of courses.list()) {
      if (c.examDate) out.push({ scope: { courseId: c.id }, examDate: c.examDate })
      for (const s of tree.children(c.id, null)) visit(s)
    }
    return out
  }

  function previewRemote(updates: readonly Uint8Array[]): DeletionReport {
    const scratch = new Y.Doc()
    try {
      Y.applyUpdateV2(scratch, Y.encodeStateAsUpdateV2(doc))
      const touched = track(scratch, () => {
        for (const u of updates) Y.applyUpdateV2(scratch, u, REMOTE)
      })
      return deletionsBetween(doc, scratch, touched)
    } finally {
      scratch.destroy()
    }
  }

  /** Brings back, forward, what `report` says was deleted (a local edit: it syncs out like any other). */
  function restoreForward(report: DeletionReport): void {
    doc.transact(() => {
      for (const e of report.entities) {
        const root = repos[e.kind].yRoot
        const m = root.get(e.id)
        if (m instanceof Y.Map) {
          if (m.has('deletedAt')) m.delete('deletedAt')
          if (m.has('purgedAt')) m.delete('purgedAt')
          continue
        }
        const back = new Y.Map<unknown>()
        root.set(e.id, back)
        for (const [k, v] of Object.entries(e.fields)) if (k !== 'deletedAt' && k !== 'purgedAt') back.set(k, v)
      }
      for (const t of report.texts) {
        const cur = texts.get(t.key)
        if (cur instanceof Y.Text) applyForward(cur, t.before)
        else texts.set(t.key, new Y.Text(t.before))
      }
    })
  }

  const api: ModelWorkspace = {
    doc,
    courses,
    sources,
    fiches,
    cards,
    sections,
    moveItem,
    scoped,
    exams,
    reviews,
    aiUsage,
    sessions,
    plans,
    drafts,
    search,
    prefs: {
      get<K extends keyof Prefs>(k: K): Prefs[K] {
        const v = prefsMap.get(k)
        return v === undefined ? PREF_DEFAULTS[k] : (v as Prefs[K])
      },
      set<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
        prefsMap.set(k, v)
      },
    },
    text,
    batch<T>(fn: () => T): T {
      let out: { v: T } | undefined
      doc.transact(() => {
        out = { v: fn() }
      })
      if (!out) throw new Error('batch: transaction did not run')
      return out.v
    },
    atomic<T>(fn: () => T): T {
      if (doc._transaction !== null) return fn()
      const origin = { atomic: true }
      const roots = [...Object.values(repos).map((r) => r.yRoot), texts, ...reviews.yRoots, sessions.yArray, prefsMap]
      const um = new Y.UndoManager(roots, {
        trackedOrigins: new Set([origin]),
        captureTimeout: 0,
      })
      try {
        const box: { out?: { v: T } | { e: unknown } } = {}
        doc.transact(() => {
          try {
            box.out = { v: fn() }
          } catch (e) {
            box.out = { e }
          }
        }, origin)
        const out = box.out ?? { e: new Error('atomic: transaction did not run') }
        if ('e' in out) {
          um.undo()
          throw out.e
        }
        return out.v
      } finally {
        um.destroy()
      }
    },
    subscribe,
    previewRemote,
    absorbHeld(updates, mode) {
      const report = previewRemote(updates)
      Y.transact(
        doc,
        () => {
          for (const u of updates) Y.applyUpdateV2(doc, u)
        },
        REMOTE,
        false,
      )
      if (mode === 'keep' && report.total > 0) restoreForward(report)
      return report
    },
    dispose() {
      search.dispose()
    },
  }
  return api
}
