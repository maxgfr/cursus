import type { Runtime } from '../../app/workspaceContext.tsx'
import { detectDeckFormat, importDeck, titleFromName } from '../../core/content/deck'
import { prepareImage } from '../../core/content/image'
import type { Id } from '../../core/contracts/workspace'
import { blobStore } from '../../core/log/blobs'
import type { SourceRecord } from '../../core/model/schema'
import { DECK_ACCEPT, loadDeck, saveDeckSource, storeDeckFiles } from '../DeckImport/deckSource.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'

/** File name without its extension, as a default title. */
function baseName(name: string | undefined, fallback: string): string {
  const n = (name ?? '').replace(/\.[^.]+$/, '').trim()
  return n === '' ? fallback : n
}

/** Where a new source lands: a course root, or one of its sections. */
export interface Where {
  courseId: Id
  sectionId?: Id
}

const at = (w: Id | Where): Where => (typeof w === 'string' ? { courseId: w } : w)

/** A note source; pasted text lands in its body in the same transaction. */
export function addNote(rt: Runtime, where: Id | Where, title: string, body = ''): Id {
  return rt.ws.batch(() => {
    const id = rt.ws.sources.create({ ...at(where), kind: 'note', title })
    if (body !== '') rt.ws.text({ id, field: 'body' }).insert(0, body)
    return id
  })
}

/** Stores the PDF durably first, then references it from a new source. */
export async function addPdf(rt: Runtime, where: Id | Where, file: File, fallback: string): Promise<Id> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const blobId = await blobStore(rt.store).put(bytes, 'application/pdf')
  return rt.ws.sources.create({ ...at(where), kind: 'pdf', title: baseName(file.name, fallback), blobId })
}

/** Downscales the photo on this device, stores it, then references it from a new source. */
export async function addImage(
  rt: Runtime,
  where: Id | Where,
  blob: Blob,
  name: string | undefined,
  fallback: string,
): Promise<Id> {
  const prepared = await prepareImage(blob)
  const bytes = new Uint8Array(await prepared.blob.arrayBuffer())
  const blobId = await blobStore(rt.store).put(bytes, prepared.mime)
  return rt.ws.sources.create({ ...at(where), kind: 'image', title: baseName(name, fallback), blobId })
}

/** The stored file of a source, or null when it has not reached this device yet. */
export function loadBlob(rt: Runtime, blobId: string): Promise<Blob | null> {
  return blobStore(rt.store).get(blobId)
}

/** Everything « Add files » takes: PDF, PowerPoint and Word, photos, and plain text or Markdown. */
export const FILES_ACCEPT = [DECK_ACCEPT, 'image/*', '.txt', '.md', '.markdown', 'text/plain', 'text/markdown'].join(
  ',',
)

const TEXT_NAME = /\.(txt|md|markdown)$/i

const isText = (file: File): boolean =>
  file.type === 'text/plain' || file.type === 'text/markdown' || TEXT_NAME.test(file.name)

/** Default titles of a file whose name and content give none. */
export interface FileFallbacks {
  note: string
  photo: string
  pdf: string
  deck: string
}

/**
 * Adds one file as a source, routed by what its bytes are: a PDF, .pptx or .docx is read on this device into
 * slides or pages (the original kept), a photo becomes a photo, a text or Markdown file becomes a note. A PDF
 * this device cannot read (password, damaged) is still kept, as a file to open in the system viewer.
 */
export async function addFile(rt: Runtime, where: Id | Where, file: File, fallback: FileFallbacks): Promise<Id> {
  if (file.type.startsWith('image/')) return addImage(rt, where, file, file.name, fallback.photo)
  if (isText(file)) return addNote(rt, where, baseName(file.name, fallback.note), await file.text())
  const bytes = new Uint8Array(await file.arrayBuffer())
  const format = detectDeckFormat(bytes)
  try {
    const deck = await importDeck(bytes, { name: file.name })
    const title = readable(deck.title) || readable(titleFromName(file.name)) || fallback.deck
    return await saveDeckSource(rt, at(where), { deck, bytes }, title)
  } catch (e) {
    if (format !== 'pdf') throw e
    // Kept as a file to open: nothing the student chose is dropped.
    noteError('course.pdfUnread', e)
    return addPdf(rt, where, file, fallback.pdf)
  }
}

/** A title written like a file name (`BSc_PT_01_final`) read as words. */
function readable(title: string): string {
  return title.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The title a file would give its source: the document's own title, else its file name, cleaned. */
export async function fileTitle(file: File): Promise<string> {
  const fromName = readable(titleFromName(file.name))
  if (file.type.startsWith('image/') || isText(file)) return fromName
  try {
    const deck = await importDeck(new Uint8Array(await file.arrayBuffer()), { name: file.name })
    return readable(deck.title) || fromName
  } catch (e) {
    // The import that follows reports it; the name still gives a title.
    noteError('course.fileTitle', e)
    return fromName
  }
}

/**
 * Reads a PDF kept as a mere attachment into pages, in place: the same source (notes, cards and citations kept)
 * gains `support` and the images of its pages; the stored file stays the original.
 */
export async function readPdfInApp(rt: Runtime, source: Pick<SourceRecord, 'id' | 'blobId' | 'title'>): Promise<void> {
  const loaded = await loadDeck(rt, source)
  const { support, blobId, blobIds } = await storeDeckFiles(rt.store, loaded)
  rt.ws.atomic(() => rt.ws.sources.update(source.id, { support, blobId, blobIds }))
}
