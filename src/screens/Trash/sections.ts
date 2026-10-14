import type { Id } from '../../core/contracts/workspace'
import { PATH_SEPARATOR } from '../../core/model/sections'
import type { ModelWorkspace } from '../../core/model/workspace'

/** What a trashed subset holds and brings back on restore: sub-subsets and the items filed in them. */
export interface SectionContents {
  sections: number
  cards: number
  sources: number
  fiches: number
}

export interface TrashedSection {
  id: Id
  /** "Law › Contracts": the course, then the path down to the subset. */
  path: string
  deletedAt: number
  contents: SectionContents
  /** Ids that "delete forever" removes with it: its sub-subsets and the items filed in the subtree. */
  inside: { sections: Id[]; cards: Id[]; sources: Id[]; fiches: Id[] }
}

const ITEMS = ['cards', 'sources', 'fiches'] as const

/**
 * Subsets the student moved to the trash themselves, most recent first. Items they trashed one by one are
 * listed on their own and are not counted here.
 */
export function trashedSections(ws: ModelWorkspace): TrashedSection[] {
  const tree = ws.sections.tree()
  const out: TrashedSection[] = []
  for (const s of ws.sections.list({ trashed: true })) {
    const course = ws.courses.get(s.courseId)
    const path = [course?.title ?? '', ...tree.chain(s.id).map((x) => x.name)].filter((x) => x !== '')
    const sections = tree.subtree(s.id).filter((id) => id !== s.id && tree.get(id)?.deletedAt === undefined)
    const inside = { sections, cards: [] as Id[], sources: [] as Id[], fiches: [] as Id[] }
    for (const kind of ITEMS) {
      for (const e of ws[kind].all()) {
        if (e.purgedAt !== undefined || e.deletedAt !== undefined) continue
        if (tree.locate(e).includes(s.id)) inside[kind].push(e.id)
      }
    }
    out.push({
      id: s.id,
      path: path.join(PATH_SEPARATOR),
      deletedAt: s.deletedAt ?? s.updatedAt,
      contents: {
        sections: sections.length,
        cards: inside.cards.length,
        sources: inside.sources.length,
        fiches: inside.fiches.length,
      },
      inside,
    })
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt)
}

/** Deletes a trashed subset forever with everything still filed in it, in one batch. */
export function purgeSection(ws: ModelWorkspace, t: TrashedSection): void {
  ws.batch(() => {
    for (const kind of ITEMS) for (const id of t.inside[kind]) ws[kind].purge(id)
    for (const id of t.inside.sections) ws.sections.purge(id)
    ws.sections.purge(t.id)
  })
}
