import type { Runtime } from '../../app/workspaceContext.tsx'
import { ImageError } from '../../core/content/image'
import { isHeic, makeThumbnail, PHOTO_MIME, preparePhoto, thumbnails } from '../../core/content/photos'
import type { Id } from '../../core/contracts/workspace'
import { blobStore } from '../../core/log/blobs'
import { addPhoto } from '../../core/model/photos'
import { noteError } from '../settings/Diagnostic/recent.ts'

export interface Where {
  courseId: Id
  sectionId?: Id
}

export type CaptureFailure = { name: string; reason: 'heic' | 'too-large' | 'unreadable' }

export interface Captured {
  ids: Id[]
  /** The photo stored for each new id (bare blob id). */
  blobIds: string[]
  failed: CaptureFailure[]
}

type Picked = Blob & { name?: string }

/** File name without its extension, as a title; the camera's generic "image" counts as no name. */
function baseName(name: string | undefined): string {
  const n = (name ?? '').replace(/\.[^.]+$/, '').trim()
  return /^image$/i.test(n) ? '' : n
}

function failureOf(file: Picked, e: unknown): CaptureFailure {
  const name = file.name?.trim() || '—'
  if (e instanceof ImageError) {
    if (e.kind === 'too-large') return { name, reason: 'too-large' }
    if (e.kind === 'unsupported' && isHeic(file)) return { name, reason: 'heic' }
  }
  return { name, reason: 'unreadable' }
}

/**
 * Adds photos to a course or subset, one by one: each is reduced on this device (2048 px, JPEG), its file stored
 * durably, its thumbnail cached, and only then the photo is created. A file that cannot be read is reported and
 * the others still go in.
 */
export async function capturePhotos(
  rt: Runtime,
  where: Where,
  files: readonly Picked[],
  untitled: () => string,
): Promise<Captured> {
  const out: Captured = { ids: [], blobIds: [], failed: [] }
  const blobs = blobStore(rt.store)
  for (const file of files) {
    let prepared: Awaited<ReturnType<typeof preparePhoto>>
    try {
      prepared = await preparePhoto(file)
    } catch (e) {
      noteError('photos.capture', e)
      out.failed.push(failureOf(file, e))
      continue
    }
    const blobId = await blobs.put(new Uint8Array(await prepared.blob.arrayBuffer()), PHOTO_MIME)
    try {
      await thumbnails.put(blobId, await makeThumbnail(prepared.blob))
    } catch (e) {
      // Only a preview: the gallery computes it again later.
      noteError('photos.thumbnail', e)
    }
    const id = addPhoto(rt.ws, {
      ...where,
      title: baseName(file.name) || untitled(),
      blobId,
      width: prepared.width,
      height: prepared.height,
    })
    out.ids.push(id)
    out.blobIds.push(blobId)
  }
  return out
}
