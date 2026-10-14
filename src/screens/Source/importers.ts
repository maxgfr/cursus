import type { Runtime } from '../../app/workspaceContext.tsx'
import { prepareImage } from '../../core/content/image'
import type { Id } from '../../core/contracts/workspace'
import { blobStore } from '../../core/log/blobs'

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
