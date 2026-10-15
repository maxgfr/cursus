import type MiniSearch from 'minisearch'
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

/**
 * Full-text index kept current on every transaction. Reads only; never writes. Built on the first search,
 * not at launch: indexing a large library would delay the first screen, and the engine (minisearch) is
 * loaded then too, so it is no part of the first screen's code.
 */
export class SearchIndex {
  /** The index, once the first search has loaded the engine and built it. */
  private ms: MiniSearch<Doc> | null = null
  private loading: Promise<MiniSearch<Doc>> | null = null
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
    doc.on('afterTransaction', this.onTx)
  }

  /** Loads the engine and builds the index from the doc as it is then (once; again after a failed load). */
  private build(): Promise<MiniSearch<Doc>> {
    this.loading ??= import('minisearch').then(
      ({ default: Engine }) => {
        const ms = new Engine<Doc>({
          fields: ['title', 'text', 'path'],
          storeFields: ['kind', 'courseId', 'sections', 'path'],
          processTerm: (t) => fold(t),
          searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 2, path: 0.5 }, processTerm: (t) => fold(t) },
        })
        for (const kind of KINDS) for (const id of this.root(kind).keys()) this.reindex(ms, kind, id)
        this.ms = ms
        return ms
      },
      (e: unknown) => {
        // A chunk that failed to load (offline before it was cached) is fetched again by the next search.
        this.loading = null
        throw e
      },
    )
    return this.loading
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
    // Before the first search there is no index to keep current: it is built from the doc as it is then.
    const ms = this.ms
    if (!ms) return
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
          for (const id of root.keys()) if (this.shouldCheck(ms, id, kind)) dirty.set(id, kind)
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
    for (const [id, kind] of dirty) this.reindex(ms, kind, id)
  }

  private shouldCheck(ms: MiniSearch<Doc>, id: Id, kind: EntityCollection): boolean {
    return !ms.has(id) || this.root(kind).get(id) === undefined
  }

  private reindex(ms: MiniSearch<Doc>, kind: EntityCollection, id: Id): void {
    const m = this.root(kind).get(id)
    const live = m && m.get('deletedAt') === undefined && m.get('purgedAt') === undefined
    if (ms.has(id)) ms.discard(id)
    if (!m || !live) return
    const title = m.get('title')
    const rawCourse = kind === 'courses' ? id : m.get('courseId')
    const courseId = typeof rawCourse === 'string' ? rawCourse : ''
    const sectionId = m.get('sectionId')
    const place = { courseId, ...(typeof sectionId === 'string' ? { sectionId } : {}) }
    const tree = place.sectionId === undefined ? null : this.tree()
    if (tree?.itemHidden(place)) return
    const text = TEXT_FIELDS[kind].map((f) => this.texts.get(textKey(id, f))?.toString() ?? '').join('\n')
    ms.add({
      id,
      kind,
      title: typeof title === 'string' ? title : '',
      text,
      path: tree?.pathOf(place) ?? '',
      courseId,
      sections: tree?.locate(place) ?? [],
    })
  }

  /** `sectionId` keeps hits filed in that section or below it. The first search loads the engine. */
  async search(q: string, f?: { kind?: EntityCollection; courseId?: Id; sectionId?: Id }): Promise<SearchHit[]> {
    if (!q.trim()) return []
    const ms = await this.build()
    return ms
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
