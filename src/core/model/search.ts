import MiniSearch from 'minisearch'
import * as Y from 'yjs'
import type { Id } from '../contracts/workspace'
import { type EntityCollection, ROOT, TEXT_FIELDS, textKey } from './schema'
import type { SectionTree } from './sections'

export interface SearchHit {
  id: Id
  kind: EntityCollection
  score: number
  /** Path of the section holding the hit ("Law › Contracts"); absent at the course root. */
  path?: string
}

interface Doc {
  id: Id
  kind: EntityCollection
  title: string
  text: string
  /** Section path, indexed so "contracts" finds what is filed under Contracts. */
  path: string
  courseId: string
  /** Section ids from the course root down to the entity's section. */
  sections: readonly Id[]
}

const NO_SECTIONS = (): SectionTree | null => null

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
    fields: ['title', 'text', 'path'],
    storeFields: ['kind', 'courseId', 'sections', 'path'],
    processTerm: (t) => fold(t),
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 2, path: 0.5 }, processTerm: (t) => fold(t) },
  })
  private readonly texts: Y.Map<Y.Text>
  private readonly sectionRoot: Y.Map<Y.Map<unknown>>
  private readonly roots: Map<EntityCollection, Y.Map<Y.Map<unknown>>>

  /** `tree` gives the current section tree (read after the sections' own caches were invalidated). */
  constructor(
    private readonly doc: Y.Doc,
    private readonly tree: () => SectionTree | null = NO_SECTIONS,
  ) {
    this.texts = doc.getMap(ROOT.texts)
    this.sectionRoot = doc.getMap(ROOT.sections)
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
      // A section renamed, moved or trashed changes the path and visibility of everything filed below it.
      if (Object.is(type, this.sectionRoot) || type.parent === this.sectionRoot) {
        for (const kind of KINDS)
          for (const [id, m] of this.root(kind)) if (typeof m.get('sectionId') === 'string') dirty.set(id, kind)
      }
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
    const title = m.get('title')
    const rawCourse = kind === 'courses' ? id : m.get('courseId')
    const courseId = typeof rawCourse === 'string' ? rawCourse : ''
    const sectionId = m.get('sectionId')
    const place = { courseId, ...(typeof sectionId === 'string' ? { sectionId } : {}) }
    const tree = place.sectionId === undefined ? null : this.tree()
    if (tree?.itemHidden(place)) return
    const text = TEXT_FIELDS[kind].map((f) => this.texts.get(textKey(id, f))?.toString() ?? '').join('\n')
    this.ms.add({
      id,
      kind,
      title: typeof title === 'string' ? title : '',
      text,
      path: tree?.pathOf(place) ?? '',
      courseId,
      sections: tree?.locate(place) ?? [],
    })
  }

  /** `sectionId` keeps hits filed in that section or below it. */
  search(q: string, f?: { kind?: EntityCollection; courseId?: Id; sectionId?: Id }): SearchHit[] {
    if (!q.trim()) return []
    return this.ms
      .search(q, {
        filter: (r) =>
          (f?.kind === undefined || r.kind === f.kind) &&
          (f?.courseId === undefined || r.courseId === f.courseId) &&
          (f?.sectionId === undefined || (r.sections as readonly Id[]).includes(f.sectionId)),
      })
      .map((r) => {
        const hit: SearchHit = { id: String(r.id), kind: r.kind as EntityCollection, score: r.score }
        if (typeof r.path === 'string' && r.path !== '') hit.path = r.path
        return hit
      })
  }
}
