import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import type { Id } from '../contracts/workspace'
import { EntityNotFoundError, EntityRepo, type RepoDeps } from './repos'
import type { CardFields, CardRecord } from './schema'

interface Orderable {
  id: Id
  courseId: Id
  sectionId?: Id
  order?: unknown
}

/** The place a card is filed in: its course and its section as stored (absent = the course root). */
export function placeOf(c: Orderable): string {
  return `${c.courseId}/${typeof c.sectionId === 'string' ? c.sectionId : ''}`
}

const keyOf = (c: Orderable): string | null => (typeof c.order === 'string' && c.order !== '' ? c.order : null)

/** Within one place: cards with a key by key (then id), then those without one by id (creation order). */
function byPlaceOrder(a: Orderable, b: Orderable): number {
  const ka = keyOf(a)
  const kb = keyOf(b)
  if (ka !== null && kb !== null && ka !== kb) return ka < kb ? -1 : 1
  if ((ka === null) !== (kb === null)) return ka === null ? 1 : -1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Orders cards filed by hand without moving any place's cards elsewhere: from the list sorted by id, each place
 * keeps the positions its cards hold and deals them out again in its own order (`byPlaceOrder`). With no key at
 * all the list is returned as it is, so a library never reordered keeps its creation order everywhere.
 */
export function arrangeCards<T extends Orderable>(byId: readonly T[]): T[] {
  if (!byId.some((c) => keyOf(c) !== null)) return [...byId]
  const groups = new Map<string, T[]>()
  for (const c of byId) {
    const p = placeOf(c)
    const g = groups.get(p)
    if (g) g.push(c)
    else groups.set(p, [c])
  }
  for (const g of groups.values()) g.sort(byPlaceOrder)
  const next = new Map<string, number>()
  return byId.map((c) => {
    const p = placeOf(c)
    const i = next.get(p) ?? 0
    next.set(p, i + 1)
    return (groups.get(p) as T[])[i] as T
  })
}

export class CardOrderError extends Error {
  constructor(
    readonly id: Id,
    readonly beforeId: Id,
  ) {
    super(`cards: ${beforeId} is not in the place of ${id}`)
    this.name = 'CardOrderError'
  }
}

/** Cards: ordered by hand within each place (`arrangeCards`), else by creation. */
export class CardRepo extends EntityRepo<CardRecord, CardFields> {
  constructor(deps: RepoDeps) {
    super(deps, 'cards')
  }

  protected override arrange(byId: CardRecord[]): CardRecord[] {
    return arrangeCards(byId)
  }

  /**
   * Puts the card just before `beforeId`, a card of the same place, or last in its place with null. The first time
   * a place is ordered by hand, or when two devices gave two cards the same key, every card of the place gets a
   * key in the order shown, in the same transaction.
   */
  reorder(id: Id, beforeId: Id | null): void {
    const self = this.get(id)
    if (!self) throw new EntityNotFoundError('cards', id)
    const place = placeOf(self)
    const siblings = this.all().filter((c) => c.purgedAt === undefined && c.id !== id && placeOf(c) === place)
    const at = beforeId === null ? siblings.length : siblings.findIndex((c) => c.id === beforeId)
    if (at < 0) throw new CardOrderError(id, beforeId as Id)
    const keys = siblings.map(keyOf)
    const clean = keys.every((k, i) => k !== null && (i === 0 || (keys[i - 1] as string) < k))
    if (clean) {
      this.update(id, { order: generateKeyBetween(keys[at - 1] ?? null, keys[at] ?? null) })
      return
    }
    const ordered = [...siblings.slice(0, at), self, ...siblings.slice(at)]
    const fresh = generateNKeysBetween(null, null, ordered.length)
    this.deps.doc.transact(() => {
      ordered.forEach((c, i) => {
        this.update(c.id, { order: fresh[i] })
      })
    })
  }
}
