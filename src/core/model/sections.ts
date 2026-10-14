import { generateKeyBetween } from 'fractional-indexing'
import type { Id, StudyScope } from '../contracts/workspace'
import { EntityRepo, type RepoDeps } from './repos'
import type { SectionFields, SectionRecord } from './schema'

/** Joins section names into a readable path: "Law › Contracts". */
export const PATH_SEPARATOR = ' › '

/** Where an entity says it lives; an absent or unresolvable `sectionId` means the course root. */
export interface Placement {
  courseId: Id
  sectionId?: Id
}

export type SectionMoveReason = 'cycle' | 'course' | 'missing'

/** A move refused locally: under its own subtree, into another course, or under a section that is gone. */
export class SectionMoveError extends Error {
  constructor(
    readonly reason: SectionMoveReason,
    readonly id: Id,
    readonly parentId: Id,
  ) {
    super(`section ${id} cannot go under ${parentId}: ${reason}`)
    this.name = 'SectionMoveError'
  }
}

const rootKey = (courseId: Id): string => `\u0000${courseId}`

const bySiblingOrder = (a: SectionRecord, b: SectionRecord): number => {
  const oa = typeof a.order === 'string' ? a.order : ''
  const ob = typeof b.order === 'string' ? b.order : ''
  if (oa !== ob) return oa < ob ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The section tree as every device derives it from the same document, without writing anything:
 * - a link to a parent that is purged, missing, itself, or in another course points to the course root;
 * - every cycle left by concurrent moves is cut at its smallest id, which goes to the course root.
 * Each component of the parent graph has at most one cycle, so the result depends on the data only.
 */
export class SectionTree {
  private readonly byId = new Map<Id, SectionRecord>()
  private readonly parents = new Map<Id, Id | null>()
  private readonly kids = new Map<string, SectionRecord[]>()
  private readonly chains = new Map<Id, readonly SectionRecord[]>()
  private readonly hiddenMemo = new Map<Id, boolean>()

  constructor(all: readonly SectionRecord[]) {
    for (const s of all) if (s.purgedAt === undefined) this.byId.set(s.id, s)
    const link = this.parents
    for (const s of this.byId.values()) {
      const p = s.parentId
      const ok = typeof p === 'string' && p !== s.id && this.byId.get(p)?.courseId === s.courseId
      link.set(s.id, ok ? p : null)
    }
    // Out-degree ≤ 1: one walk per component finds its only possible cycle.
    const seen = new Map<Id, 'walk' | 'done'>()
    for (const start of link.keys()) {
      const walk: Id[] = []
      let cur: Id | null = start
      while (cur !== null && !seen.has(cur)) {
        seen.set(cur, 'walk')
        walk.push(cur)
        cur = link.get(cur) ?? null
      }
      if (cur !== null && seen.get(cur) === 'walk') {
        let min = cur
        for (const id of walk.slice(walk.indexOf(cur))) if (id < min) min = id
        link.set(min, null)
      }
      for (const id of walk) seen.set(id, 'done')
    }
    for (const s of this.byId.values()) {
      const key = link.get(s.id) ?? rootKey(s.courseId)
      const list = this.kids.get(key)
      if (list) list.push(s)
      else this.kids.set(key, [s])
    }
    for (const list of this.kids.values()) list.sort(bySiblingOrder)
  }

  /** A section that still exists (trashed ones included, purged ones not). */
  get(id: Id): SectionRecord | undefined {
    return this.byId.get(id)
  }

  /** Effective parent; null at the course root (and for an unknown section). */
  parent(id: Id): Id | null {
    return this.parents.get(id) ?? null
  }

  /** Every section of the tree, purged ones excluded, in no particular order. */
  ids(): readonly Id[] {
    return [...this.byId.keys()]
  }

  /** From the course root down to the section, itself included; empty for an unknown section. */
  chain(id: Id): readonly SectionRecord[] {
    const memo = this.chains.get(id)
    if (memo) return memo
    const self = this.byId.get(id)
    if (!self) return []
    const p = this.parent(id)
    const out = p === null ? [self] : [...this.chain(p), self]
    this.chains.set(id, out)
    return out
  }

  /** Trashed, or under a trashed section: hidden by derivation. */
  hidden(id: Id): boolean {
    const memo = this.hiddenMemo.get(id)
    if (memo !== undefined) return memo
    const self = this.byId.get(id)
    if (!self) return false
    const p = this.parent(id)
    const out = self.deletedAt !== undefined || (p !== null && this.hidden(p))
    this.hiddenMemo.set(id, out)
    return out
  }

  /** Direct children in sibling order; `parentId` null lists the course root. Trashed ones only on request. */
  children(courseId: Id, parentId: Id | null, o?: { trashed?: boolean }): readonly SectionRecord[] {
    const list = this.kids.get(parentId ?? rootKey(courseId)) ?? []
    const trashed = o?.trashed ?? false
    return list.filter((s) => s.courseId === courseId && (trashed || s.deletedAt === undefined))
  }

  /** The section and all its descendants (trashed ones included), depth first in sibling order. */
  subtree(id: Id): readonly Id[] {
    if (!this.byId.has(id)) return []
    const out: Id[] = []
    const visit = (s: Id): void => {
      out.push(s)
      for (const c of this.kids.get(s) ?? []) visit(c.id)
    }
    visit(id)
    return out
  }

  /** The section an entity resolves to, or null at its course root. */
  sectionOf(item: Placement): Id | null {
    const id = item.sectionId
    if (typeof id !== 'string') return null
    return this.byId.get(id)?.courseId === item.courseId ? id : null
  }

  /** Ids from the course root down to the entity's section; empty at the course root. */
  locate(item: Placement): readonly Id[] {
    const s = this.sectionOf(item)
    return s === null ? [] : this.chain(s).map((x) => x.id)
  }

  /** Readable path of the entity's section ("Law › Contracts"); empty at the course root. */
  pathOf(item: Placement): string {
    const s = this.sectionOf(item)
    return s === null
      ? ''
      : this.chain(s)
          .map((x) => x.name)
          .join(PATH_SEPARATOR)
  }

  /** Inside a trashed section, or below one. */
  itemHidden(item: Placement): boolean {
    const s = this.sectionOf(item)
    return s !== null && this.hidden(s)
  }

  /** In the course, and inside the scope's section or any of its descendants. */
  contains(scope: StudyScope, item: Placement): boolean {
    if (item.courseId !== scope.courseId) return false
    if (scope.sectionId === undefined) return true
    return this.locate(item).includes(scope.sectionId)
  }
}

/** Subsets: an ordered repo whose tree is derived at read time and cached until the next change. */
export class SectionRepo extends EntityRepo<SectionRecord, SectionFields> {
  private cached: SectionTree | null = null

  constructor(deps: RepoDeps) {
    super(deps, 'sections', true)
    // A section below a trashed one leaves the listings with it; restoring brings it back.
    this.hideWhen((s) => {
      const p = this.tree().parent(s.id)
      return p !== null && this.tree().hidden(p)
    })
  }

  /** The tree is derived from the entities: it goes stale with them, including mid-transaction. */
  protected override invalidate(): void {
    super.invalidate()
    this.cached = null
  }

  tree(): SectionTree {
    this.cached ??= new SectionTree(this.all())
    return this.cached
  }

  private check(id: Id | null, courseId: Id, parentId: Id): void {
    const parent = this.tree().get(parentId)
    if (!parent) throw new SectionMoveError('missing', id ?? '', parentId)
    if (parent.courseId !== courseId) throw new SectionMoveError('course', id ?? '', parentId)
    if (id !== null && this.tree().subtree(id).includes(parentId)) throw new SectionMoveError('cycle', id, parentId)
  }

  override create(i: SectionFields): Id {
    if (i.parentId !== undefined) this.check(null, i.courseId, i.parentId)
    return super.create(i)
  }

  /** `parentId` goes through the same checks as `move`; a section never changes course on its own. */
  override update(id: Id, p: Partial<SectionFields>): void {
    const self = this.entity(id)
    const courseId = String(self.get('courseId'))
    if (p.courseId !== undefined && p.courseId !== courseId) throw new SectionMoveError('course', id, p.courseId)
    if (p.parentId !== undefined) this.check(id, courseId, p.parentId)
    super.update(id, p)
  }

  move(id: Id, parentId: Id | null): void {
    this.entity(id)
    this.update(id, { parentId: parentId ?? undefined })
  }

  path(id: Id): readonly SectionRecord[] {
    return this.tree().chain(id)
  }

  subtree(id: Id): readonly Id[] {
    return this.tree().subtree(id)
  }

  children(courseId: Id, parentId: Id | null): readonly SectionRecord[] {
    return this.tree().children(courseId, parentId)
  }

  /** Puts the section just before the sibling `beforeId`, or last among its siblings with null. */
  reorder(id: Id, beforeId: Id | null): void {
    const self = this.entity(id)
    const tree = this.tree()
    const courseId = String(self.get('courseId'))
    const siblings = tree.children(courseId, tree.parent(id), { trashed: true }).filter((s) => s.id !== id)
    const key = (s: SectionRecord | undefined): string | null =>
      s !== undefined && typeof s.order === 'string' && s.order !== '' ? s.order : null
    let order: string
    const at = beforeId === null ? -1 : siblings.findIndex((s) => s.id === beforeId)
    if (at < 0) {
      if (beforeId !== null) throw new SectionMoveError('missing', id, beforeId)
      order = generateKeyBetween(key(siblings.at(-1)), null)
    } else {
      const upper = key(siblings[at])
      // Equal keys (two devices created siblings at once) have nothing between them: go below the group.
      let lower: string | null = null
      for (let i = at - 1; i >= 0; i--) {
        const k = key(siblings[i])
        if (k !== null && (upper === null || k < upper)) {
          lower = k
          break
        }
      }
      order = generateKeyBetween(lower, upper)
    }
    this.update(id, { order })
  }
}
