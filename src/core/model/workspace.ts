import type * as Y from 'yjs'
import type { Clock, Rng } from '../contracts/ports'
import type { Id, Prefs, Scope, Workspace } from '../contracts/workspace'
import { EntityRepo } from './repos'
import { AiUsageLog, ReviewLog } from './reviews'
import {
  type CardFields,
  type CardRecord,
  type CourseFields,
  type CourseRecord,
  type EntityCollection,
  type FicheFields,
  type FicheRecord,
  PREF_DEFAULTS,
  ROOT,
  type SourceFields,
  type SourceRecord,
  type TextField,
  textKey,
} from './schema'
import { SearchIndex } from './search'

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
  reviews: ReviewLog
  aiUsage: AiUsageLog
  search: SearchIndex
  dispose(): void
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
  const cards = Object.assign(cardRepo, {
    move(id: Id, courseId: Id): void {
      cardRepo.update(id, { courseId })
    },
  })
  const reviews = new ReviewLog(doc, deps.rng, deps.deviceId)
  const aiUsage = new AiUsageLog(doc, deps.rng, deps.clock, deps.deviceId)
  const prefsMap = doc.getMap<unknown>(ROOT.prefs)
  const texts = doc.getMap<Y.Text>(ROOT.texts)
  const search = new SearchIndex(doc)
  const repos: Record<EntityCollection, EntityRepo<{ id: Id; createdAt: number; updatedAt: number }, object>> = {
    courses,
    sources,
    fiches,
    cards: cardRepo,
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
      const target: Observable =
        scope === 'reviews' ? reviews.yArray : scope === 'prefs' ? prefsMap : repos[scope].yRoot
      target.observeDeep(handler)
      return () => target.unobserveDeep(handler)
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

  return {
    doc,
    courses,
    sources,
    fiches,
    cards,
    reviews,
    aiUsage,
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
    subscribe,
    dispose() {
      search.dispose()
    },
  }
}
