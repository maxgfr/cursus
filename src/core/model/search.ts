import MiniSearch from 'minisearch'
import * as Y from 'yjs'
import type { Id } from '../contracts/workspace'
import { type EntityCollection, ROOT, TEXT_FIELDS, textKey } from './schema'

export interface SearchHit {
  id: Id
  kind: EntityCollection
  score: number
}

interface Doc {
  id: Id
  kind: EntityCollection
  title: string
  text: string
  courseId: string
}

const KINDS: readonly EntityCollection[] = ['courses', 'sources', 'fiches', 'cards']

/** Lowercase and strip diacritics: "Élève" -> "eleve". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

/** Full-text index kept current on every transaction. Reads only; never writes. */
export class SearchIndex {
  private readonly ms = new MiniSearch<Doc>({
    fields: ['title', 'text'],
    storeFields: ['kind', 'courseId'],
    processTerm: (t) => fold(t),
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 2 }, processTerm: (t) => fold(t) },
  })
  private readonly texts: Y.Map<Y.Text>
  private readonly roots: Map<EntityCollection, Y.Map<Y.Map<unknown>>>

  constructor(private readonly doc: Y.Doc) {
    this.texts = doc.getMap(ROOT.texts)
    this.roots = new Map(KINDS.map((k) => [k, doc.getMap<Y.Map<unknown>>(ROOT[k])]))
    for (const kind of KINDS) for (const id of this.root(kind).keys()) this.reindex(kind, id)
    doc.on('afterTransaction', this.onTx)
  }

  dispose(): void {
    this.doc.off('afterTransaction', this.onTx)
  }

  private root(kind: EntityCollection): Y.Map<Y.Map<unknown>> {
    const r = this.roots.get(kind)
    if (!r) throw new Error(`unknown collection ${kind}`)
    return r
  }

  private readonly onTx = (tr: Y.Transaction): void => {
    const dirty = new Map<Id, EntityCollection>()
    for (const type of tr.changedParentTypes.keys()) {
      for (const kind of KINDS) {
        const root = this.root(kind)
        if (Object.is(type, root)) {
          for (const id of root.keys()) if (this.shouldCheck(id, kind)) dirty.set(id, kind)
        } else if (type.parent === root && type instanceof Y.Map) {
          dirty.set(String(type.get('id')), kind)
        }
      }
      if (type.parent === this.texts && type instanceof Y.Text) {
        const key = type._item?.parentSub
        const id = key ? key.slice(0, key.lastIndexOf('/')) : undefined
        if (id) {
          for (const kind of KINDS) if (this.root(kind).has(id)) dirty.set(id, kind)
        }
      }
    }
    for (const [id, kind] of dirty) this.reindex(kind, id)
  }

  private shouldCheck(id: Id, kind: EntityCollection): boolean {
    return !this.ms.has(id) || this.root(kind).get(id) === undefined
  }

  private reindex(kind: EntityCollection, id: Id): void {
    const m = this.root(kind).get(id)
    const live = m && m.get('deletedAt') === undefined && m.get('purgedAt') === undefined
    if (this.ms.has(id)) this.ms.discard(id)
    if (!m || !live) return
    const text = TEXT_FIELDS[kind].map((f) => this.texts.get(textKey(id, f))?.toString() ?? '').join('\n')
    const title = m.get('title')
    const courseId = kind === 'courses' ? id : m.get('courseId')
    this.ms.add({
      id,
      kind,
      title: typeof title === 'string' ? title : '',
      text,
      courseId: typeof courseId === 'string' ? courseId : '',
    })
  }

  search(q: string, f?: { kind?: EntityCollection; courseId?: Id }): SearchHit[] {
    if (!q.trim()) return []
    return this.ms
      .search(q, {
        filter: (r) =>
          (f?.kind === undefined || r.kind === f.kind) && (f?.courseId === undefined || r.courseId === f.courseId),
      })
      .map((r) => ({ id: String(r.id), kind: r.kind as EntityCollection, score: r.score }))
  }
}
