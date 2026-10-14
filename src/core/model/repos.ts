import { generateKeyBetween } from 'fractional-indexing'
import * as Y from 'yjs'
import type { Clock, Rng } from '../contracts/ports'
import type { Id, Repo } from '../contracts/workspace'
import { type EntityCollection, ROOT, TEXT_FIELDS, textKey } from './schema'

export type Scalar = string | number | boolean | null | readonly unknown[] | Record<string, unknown>

interface Meta {
  id: Id
  createdAt: number
  updatedAt: number
  deletedAt?: number
  purgedAt?: number
}

export interface RepoDeps {
  doc: Y.Doc
  rng: Rng
  clock: Clock
}

export class EntityNotFoundError extends Error {
  constructor(
    readonly collection: string,
    readonly id: Id,
  ) {
    super(`${collection}: no entity ${id}`)
    this.name = 'EntityNotFoundError'
  }
}

function snapshot<T>(m: Y.Map<unknown>): T {
  return m.toJSON() as T
}

/**
 * Generic repo over a top-level Y.Map<Y.Map<scalar>>.
 * Snapshots are memoized and invalidated on any deep change of the collection.
 */
export class EntityRepo<T extends Meta, In extends object> implements Repo<T, In> {
  private readonly root: Y.Map<Y.Map<unknown>>
  private readonly texts: Y.Map<Y.Text>
  private cache: readonly T[] | null = null
  private byId = new Map<Id, T>()

  constructor(
    private readonly deps: RepoDeps,
    readonly name: EntityCollection,
    private readonly ordered = false,
  ) {
    this.root = deps.doc.getMap(ROOT[name])
    this.texts = deps.doc.getMap(ROOT.texts)
    this.root.observeDeep(() => {
      this.cache = null
    })
  }

  get yRoot(): Y.Map<Y.Map<unknown>> {
    return this.root
  }

  private all(): readonly T[] {
    if (this.cache) return this.cache
    const out: T[] = []
    const byId = new Map<Id, T>()
    for (const m of this.root.values()) {
      const prev = this.byId.get(String(m.get('id')))
      const next = snapshot<T>(m)
      // Keep identity of unchanged snapshots for useSyncExternalStore.
      const keep = prev && shallowEqual(prev, next) ? prev : next
      out.push(keep)
      byId.set(keep.id, keep)
    }
    if (this.ordered) {
      out.sort((a, b) => cmp(order(a), order(b)) || cmp(a.id, b.id))
    } else {
      out.sort((a, b) => cmp(a.id, b.id))
    }
    this.byId = byId
    this.cache = out
    return out
  }

  list(f?: { courseId?: Id; trashed?: boolean }): readonly T[] {
    const trashed = f?.trashed ?? false
    const courseId = f?.courseId
    const all = this.all()
    const res = all.filter(
      (e) =>
        e.purgedAt === undefined &&
        (e.deletedAt !== undefined) === trashed &&
        (courseId === undefined || (e as { courseId?: Id }).courseId === courseId),
    )
    return res.length === all.length ? all : res
  }

  get(id: Id): T | undefined {
    this.all()
    const e = this.byId.get(id)
    return e && e.purgedAt === undefined ? e : undefined
  }

  create(i: In): Id {
    const id = this.deps.rng.id()
    const now = this.deps.clock.now()
    this.deps.doc.transact(() => {
      const m = new Y.Map<unknown>()
      this.root.set(id, m)
      for (const [k, v] of Object.entries(i)) if (v !== undefined) m.set(k, v)
      if (this.ordered && m.get('order') === undefined) {
        const last = this.all()
          .filter((e) => e.id !== id)
          .at(-1)
        m.set('order', generateKeyBetween(last ? order(last) || null : null, null))
      }
      m.set('id', id)
      m.set('createdAt', now)
      m.set('updatedAt', now)
      // Nested types are created in the same transaction, never lazily.
      for (const field of TEXT_FIELDS[this.name]) this.texts.set(textKey(id, field), new Y.Text())
    })
    return id
  }

  private entity(id: Id): Y.Map<unknown> {
    const m = this.root.get(id)
    if (!m) throw new EntityNotFoundError(this.name, id)
    return m
  }

  update(id: Id, p: Partial<In>): void {
    const m = this.entity(id)
    this.deps.doc.transact(() => {
      let changed = false
      for (const [k, v] of Object.entries(p)) {
        if (k === 'id' || k === 'createdAt') continue
        if (v === undefined) {
          if (m.has(k)) {
            m.delete(k)
            changed = true
          }
        } else if (!sameValue(m.get(k), v)) {
          m.set(k, v)
          changed = true
        }
      }
      if (changed) m.set('updatedAt', this.deps.clock.now())
    })
  }

  trash(id: Id): void {
    const m = this.entity(id)
    if (m.get('deletedAt') === undefined) m.set('deletedAt', this.deps.clock.now())
  }

  restore(id: Id): void {
    const m = this.entity(id)
    this.deps.doc.transact(() => {
      m.delete('deletedAt')
      m.delete('purgedAt')
    })
  }

  purge(id: Id): void {
    const m = this.entity(id)
    const now = this.deps.clock.now()
    this.deps.doc.transact(() => {
      if (m.get('deletedAt') === undefined) m.set('deletedAt', now)
      m.set('purgedAt', now)
    })
  }
}

function order(e: object): string {
  const o = (e as { order?: unknown }).order
  return typeof o === 'string' ? o : ''
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  return ka.every((k) => sameValue(ra[k], rb[k]))
}
