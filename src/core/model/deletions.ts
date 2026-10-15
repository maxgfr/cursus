import * as Y from 'yjs'
import { ROOT } from './schema'

/** Collections whose entities count as the library when judging what a remote change deletes. */
export const GUARDED_KINDS = ['courses', 'sections', 'sources', 'fiches', 'cards'] as const
export type GuardedKind = (typeof GUARDED_KINDS)[number]

/** A text at least this long… */
export const TEXT_MIN_CHARS = 200
/** …that loses at least this share of its characters is emptied: it counts as one deletion. */
export const TEXT_EMPTIED_SHARE = 0.8

/** Live: present, neither trashed (`deletedAt`) nor purged (`purgedAt`). */
export function isLive(m: unknown): boolean {
  return m instanceof Y.Map && m.get('deletedAt') === undefined && m.get('purgedAt') === undefined
}

/** Did a text going from `before` to `after` characters lose most of a substantial content? */
export function isEmptied(before: number, after: number): boolean {
  return before >= TEXT_MIN_CHARS && before - after >= before * TEXT_EMPTIED_SHARE
}

export interface Touched {
  /** `kind/id` of every guarded entity whose map, or whose entry in its collection, changed. */
  entities: Map<string, { kind: GuardedKind; id: string }>
  /** Keys (`id/field`) of every text whose content, or whose entry in `texts`, changed. */
  texts: Set<string>
}

/** Runs `fn` (which changes `doc`) and returns which entities and texts its transactions touched. */
export function track(doc: Y.Doc, fn: () => void): Touched {
  const roots = new Map<unknown, GuardedKind>(GUARDED_KINDS.map((k) => [doc.getMap(ROOT[k]), k]))
  const texts: unknown = doc.getMap(ROOT.texts)
  const out: Touched = { entities: new Map(), texts: new Set() }
  const entity = (kind: GuardedKind, id: string) => out.entities.set(`${kind}/${id}`, { kind, id })
  const onTransaction = (tr: Y.Transaction) => {
    for (const [type, keys] of tr.changed) {
      const kind = roots.get(type)
      if (kind) {
        for (const k of keys) if (k !== null) entity(kind, k)
        continue
      }
      if (type === texts) {
        for (const k of keys) if (k !== null) out.texts.add(k)
        continue
      }
      const item = type._item
      const sub = item?.parentSub
      if (!item || sub == null) continue
      const parentKind = roots.get(item.parent)
      if (parentKind) entity(parentKind, sub)
      else if (item.parent === texts) out.texts.add(sub)
    }
  }
  doc.on('afterTransaction', onTransaction)
  try {
    fn()
  } finally {
    doc.off('afterTransaction', onTransaction)
  }
  return out
}

export interface DeletedEntity {
  kind: GuardedKind
  id: string
  /** Its title (a card: the first line of its front), as it stood before. */
  title: string
  /** Its fields as they stood before (to bring back a map that was removed outright). */
  fields: Record<string, unknown>
}

export interface DeletionReport {
  /** Entities live before and trashed, purged or removed after. */
  entities: DeletedEntity[]
  /** Texts emptied (see `isEmptied`), with their content before. */
  texts: { key: string; before: string }[]
  counts: Record<GuardedKind | 'texts', number>
  /** Entities plus emptied texts. */
  total: number
}

const titleOf = (doc: Y.Doc, kind: GuardedKind, id: string, m: Y.Map<unknown>): string => {
  if (kind === 'cards') {
    const front = doc.getMap<Y.Text>(ROOT.texts).get(`${id}/front`)
    return front instanceof Y.Text ? (front.toString().split('\n')[0] ?? '') : ''
  }
  // A section is named, everything else titled.
  const title = m.get(kind === 'sections' ? 'name' : 'title')
  return typeof title === 'string' ? title : ''
}

/**
 * What changed for the worse between `before` and `after` among `touched`: entities that were live and no longer
 * are, texts that were emptied. Reads only; `before` is typically the live doc and `after` a scratch copy.
 */
export function deletionsBetween(before: Y.Doc, after: Y.Doc, touched: Touched): DeletionReport {
  const counts: DeletionReport['counts'] = { courses: 0, sections: 0, sources: 0, fiches: 0, cards: 0, texts: 0 }
  const entities: DeletedEntity[] = []
  for (const { kind, id } of touched.entities.values()) {
    const was = before.getMap<Y.Map<unknown>>(ROOT[kind]).get(id)
    if (!(was instanceof Y.Map) || !isLive(was) || isLive(after.getMap(ROOT[kind]).get(id))) continue
    entities.push({ kind, id, title: titleOf(before, kind, id, was), fields: was.toJSON() as Record<string, unknown> })
    counts[kind]++
  }
  const texts: DeletionReport['texts'] = []
  for (const key of touched.texts) {
    const was = before.getMap(ROOT.texts).get(key)
    const now = after.getMap(ROOT.texts).get(key)
    const text = was instanceof Y.Text ? was.toString() : ''
    if (!isEmptied(text.length, now instanceof Y.Text ? now.length : 0)) continue
    texts.push({ key, before: text })
    counts.texts++
  }
  const order = (a: { kind: string; id: string }, b: { kind: string; id: string }) =>
    GUARDED_KINDS.indexOf(a.kind as GuardedKind) - GUARDED_KINDS.indexOf(b.kind as GuardedKind) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  entities.sort(order)
  texts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { entities, texts, counts, total: entities.length + texts.length }
}
