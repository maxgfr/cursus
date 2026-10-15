import { normalizeRotation, photoRef, type Rotation, turn } from '../content/photos'
import type { Id, StudyScope } from '../contracts/workspace'
import type { SourceRecord } from './schema'
import type { ModelWorkspace } from './workspace'

/**
 * A photo is a source of kind `image` that has a stored file: it lives in a course or one of its subsets, goes to
 * the trash, moves and syncs like any source, and the AI can cite it. Everything here writes through the
 * Workspace's repos; nothing touches Yjs directly.
 */
export interface Photo {
  id: Id
  courseId: Id
  sectionId?: Id
  title: string
  /** Bare sha256 of the stored file's manifest. */
  blobId: string
  caption: string
  rotation: Rotation
  attachedTo?: Id
  width?: number
  height?: number
  createdAt: number
}

export function isPhoto(s: SourceRecord): boolean {
  return s.kind === 'image' && typeof s.blobId === 'string' && s.blobId !== ''
}

export function toPhoto(s: SourceRecord): Photo {
  return {
    id: s.id,
    courseId: s.courseId,
    ...(s.sectionId === undefined ? {} : { sectionId: s.sectionId }),
    title: s.title,
    blobId: s.blobId ?? '',
    caption: s.caption ?? '',
    rotation: normalizeRotation(s.rotation),
    ...(s.attachedTo === undefined ? {} : { attachedTo: s.attachedTo }),
    ...(s.width === undefined ? {} : { width: s.width }),
    ...(s.height === undefined ? {} : { height: s.height }),
    createdAt: s.createdAt,
  }
}

/** Newest first; ids break ties so every device shows the same order. */
const newestFirst = (a: Photo, b: Photo): number =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** Live photos of a course or subset (its descendants included), newest first. */
export function listPhotos(ws: ModelWorkspace, scope: StudyScope): Photo[] {
  return ws.scoped('sources', scope).filter(isPhoto).map(toPhoto).sort(newestFirst)
}

export function countPhotos(ws: ModelWorkspace, scope: StudyScope): number {
  return ws.scoped('sources', scope).filter(isPhoto).length
}

/** A live photo, or undefined (trashed, purged, or not a photo). */
export function getPhoto(ws: ModelWorkspace, id: Id): Photo | undefined {
  const s = ws.sources.get(id)
  return s && s.deletedAt === undefined && isPhoto(s) ? toPhoto(s) : undefined
}

/** Live photos attached to a note or PDF, newest first. */
export function photosAttachedTo(ws: ModelWorkspace, sourceId: Id): Photo[] {
  const s = ws.sources.get(sourceId)
  if (!s) return []
  return ws.sources
    .list({ courseId: s.courseId })
    .filter((p) => isPhoto(p) && p.attachedTo === sourceId)
    .map(toPhoto)
    .sort(newestFirst)
}

/** Notes and PDFs of a course a photo can be attached to. */
export function attachableSources(ws: ModelWorkspace, courseId: Id): readonly SourceRecord[] {
  return ws.sources.list({ courseId }).filter((s) => s.kind !== 'image')
}

export interface NewPhoto {
  courseId: Id
  sectionId?: Id
  title: string
  /** Stored (durably) BEFORE this call: the transaction that names it must never precede its file. */
  blobId: string
  width?: number
  height?: number
  caption?: string
  attachedTo?: Id
}

export function addPhoto(ws: ModelWorkspace, p: NewPhoto): Id {
  return ws.sources.create({
    courseId: p.courseId,
    ...(p.sectionId === undefined ? {} : { sectionId: p.sectionId }),
    kind: 'image',
    title: p.title,
    blobId: p.blobId,
    photo: photoRef(p.blobId),
    ...(p.width === undefined ? {} : { width: p.width }),
    ...(p.height === undefined ? {} : { height: p.height }),
    ...(p.caption ? { caption: p.caption } : {}),
    ...(p.attachedTo === undefined ? {} : { attachedTo: p.attachedTo }),
  })
}

export function setCaption(ws: ModelWorkspace, id: Id, caption: string): void {
  const text = caption.trim()
  ws.sources.update(id, { caption: text === '' ? undefined : text })
}

export function rotatePhoto(ws: ModelWorkspace, id: Id, by: 90 | -90): Rotation {
  const next = turn(ws.sources.get(id)?.rotation, by)
  ws.sources.update(id, { rotation: next === 0 ? undefined : next })
  return next
}

/** Attaches a photo to a note or PDF of its course, or detaches it (null). */
export function attachPhoto(ws: ModelWorkspace, id: Id, sourceId: Id | null): void {
  if (sourceId === null) {
    ws.sources.update(id, { attachedTo: undefined })
    return
  }
  const photo = ws.sources.get(id)
  const target = ws.sources.get(sourceId)
  if (!photo || !target || target.kind === 'image' || target.courseId !== photo.courseId) {
    throw new RangeError(`Cannot attach ${id} to ${sourceId}`)
  }
  ws.sources.update(id, { attachedTo: sourceId })
}

/** What a photo is called for people (VoiceOver, share sheet): its caption, else its title. */
export function photoLabel(p: Pick<Photo, 'caption' | 'title'>): string {
  return p.caption.trim() !== '' ? p.caption.trim() : p.title
}
