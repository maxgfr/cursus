import type { Id, StudyScope } from '../../core/contracts/workspace'
import type { ModelWorkspace } from '../../core/model/workspace'

/**
 * A new study sheet in a course or one of its subsets: its body is created empty with it, in the same write. `sources`
 * are those it is written from (a summary of one source names it).
 */
export function createFiche(ws: ModelWorkspace, place: StudyScope, title: string, sources: readonly Id[] = []): Id {
  return ws.fiches.create({
    courseId: place.courseId,
    ...(place.sectionId === undefined ? {} : { sectionId: place.sectionId }),
    title,
    sourceIds: [...sources],
  })
}

/** Where a sheet opens to be written by AI at once (`?write=1`). */
export const WRITE_QUERY = 'write=1'
