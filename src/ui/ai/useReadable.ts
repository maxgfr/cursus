import { useEffect, useState } from 'react'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { StudyScope } from '../../core/contracts/workspace'
import type { SourceRecord } from '../../core/model/schema'
import { isReadable, notesWritten } from '../../screens/Understand/shared/readable.ts'

/**
 * The sources of a place (its subsets' included) a model has something to read in (`isReadable`), photos read by a
 * model on this device included: those readings are looked up when the place's photos change.
 */
export function useReadableSources(place: StudyScope): { sources: readonly SourceRecord[]; read: number } {
  const rt = useRuntime()
  const all = useWorkspaceData(['sources', 'sections', { id: `${place.courseId}/${place.sectionId ?? ''}` }], (w) =>
    w.scoped('sources', place).map((source) => ({ source, notes: notesWritten(w, source.id) })),
  )
  const images = all.filter((x) => x.source.kind === 'image').map((x) => x.source.id)
  const key = images.join(',')
  const [read, setRead] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: '', ids: new Set() })
  useEffect(() => {
    if (key === '') return
    let live = true
    import('../../core/ai/features/describePhoto')
      .then(({ loadReadings }) => loadReadings(rt.store, key.split(',')))
      .then(
        (found) => {
          if (live) setRead({ key, ids: new Set(found.map((r) => r.photoId)) })
        },
        (e: unknown) => console.warn('photo readings could not be looked up', e),
      )
    return () => {
      live = false
    }
  }, [rt, key])
  const ids = read.key === key ? read.ids : new Set<string>()
  const sources = all.filter((x) => isReadable(x.source, { notes: x.notes, read: ids.has(x.source.id) }))
  return {
    sources: sources.map((x) => x.source),
    read: sources.filter((x) => x.source.kind === 'image' && ids.has(x.source.id)).length,
  }
}
