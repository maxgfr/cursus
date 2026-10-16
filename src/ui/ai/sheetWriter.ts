import { to } from '../../app/routes.ts'
import type { Runtime } from '../../app/workspaceContext.tsx'
import { type Detail, streamUnderstanding } from '../../core/ai/features/understand'
import type { Chunk } from '../../core/ai/retrieval'
import type { SourceRef, Understanding } from '../../core/ai/schemas'
import { type SheetCite, sheetMarkdown } from '../../core/ai/sheetMarkdown'
import { isPhoto, photoLabel, toPhoto } from '../../core/model/photos'
import type { ModelWorkspace } from '../../core/model/workspace'
import type { Translate } from '../../i18n/index.ts'
import { noteError } from '../../screens/settings/Diagnostic/recent.ts'
import { passagesText } from '../../screens/Understand/shared/aiConfig.ts'
import { citationText } from '../../screens/Understand/shared/citations.ts'
import { PASTED } from '../../screens/Understand/shared/sources.ts'
import type { StudyDeps } from '../chat/studyRun.ts'
import type { EditorWriter } from '../editor/aiWrite.ts'

/** What a study sheet is written on: its sources, a topic, how deep. */
export interface SheetRequest {
  courseId: string
  sourceIds: readonly string[]
  topic: string
  detail: Detail
}

/** The names of the units of the decks and documents among `chunks` (« Slide 2 »), by `sourceId/index`. */
async function unitNames(rt: Runtime, ws: ModelWorkspace, t: Translate, chunks: readonly Chunk[]) {
  const out = new Map<string, string>()
  const decks = new Set(chunks.filter((c) => c.page !== undefined).map((c) => c.sourceId))
  if (decks.size === 0) return out
  const { loadDeck, unitName } = await import('../../screens/DeckImport/deckSource.ts')
  for (const id of decks) {
    const source = ws.sources.get(id)
    if (source?.support === undefined) continue
    try {
      for (const unit of (await loadDeck(rt, source)).deck.units) out.set(`${id}/${unit.index}`, unitName(t, unit))
    } catch (e) {
      // The citation keeps its link; only the unit's name is missing.
      noteError('sheet.units', e)
    }
  }
  return out
}

/**
 * How a sheet cites a passage: the source's name and its unit (« sample · Slide 2 »), a page, or a photo's name,
 * linking to it. Null for what cannot be opened (pasted text, a source gone, one no passage came from).
 */
export function sheetCiter(
  ws: ModelWorkspace,
  t: Translate,
  names: ReadonlyMap<string, string>,
  grounded: ReadonlySet<string>,
): (ref: Partial<SourceRef> | undefined) => SheetCite | null {
  return (ref) => {
    const id = ref?.sourceId
    if (id === undefined || id === PASTED || !grounded.has(id)) return null
    const source = ws.sources.get(id)
    if (!source || source.deletedAt !== undefined) return null
    if (isPhoto(source)) return { label: photoLabel(toPhoto(source)), href: `#${to.photo(source.id)}` }
    const page = ref?.page
    const unit = page === undefined ? null : (names.get(`${id}/${page}`) ?? null)
    return {
      label: citationText(t, source.title, source, page, unit),
      href: `#${page === undefined ? to.source(id) : `${to.source(id)}?page=${page}`}`,
    }
  }
}

/**
 * Writes a study sheet into an editor as the model writes it, cited, then checked (citations of no passage sent
 * are dropped from the final text). Null when the sources hold nothing to read: nothing is asked, nothing written.
 * Stopped (`signal`), what was written stays; one undo takes it all back.
 */
export async function writeSheet(
  d: StudyDeps,
  req: SheetRequest,
  writer: EditorWriter,
  signal: AbortSignal,
): Promise<Understanding | null> {
  const chunks = await d.load({ sourceIds: [...req.sourceIds], pasted: '' })
  if (chunks.length === 0) return null
  const course = d.ws.courses.get(req.courseId)
  const ctx = await d.ai.context(signal, course?.language, passagesText(chunks))
  const names = await unitNames(d.rt, d.ws, d.t, chunks)
  const s = streamUnderstanding(ctx, { topic: req.topic, detail: req.detail, chunks })
  const cite = sheetCiter(d.ws, d.t, names, new Set(s.grounded.map((c) => c.sourceId)))
  if (!writer.begin()) throw new Error('the editor is not ready')
  try {
    for await (const part of s.partial) writer.write(sheetMarkdown(part, cite, false))
    const out = await s.output
    writer.write(sheetMarkdown(out, cite, true), true)
    return out
  } finally {
    writer.end()
  }
}
