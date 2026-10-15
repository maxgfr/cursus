import type { LocalStore } from '../contracts/ports'
import { ImageError, MAX_IMAGE_DIMENSION, MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_OUTPUT_BYTES } from './image'

/**
 * Photos: what happens to the pixels on this device (downscale, JPEG, rotation, thumbnails) and how a photo is
 * referenced from Markdown. Stored files are content addressed (`cursus-blob:<h64>`); everything here that is
 * not a stored file (thumbnails, rotated renditions) is recomputable and never synced.
 */

export const PHOTO_MAX_DIMENSION = MAX_IMAGE_DIMENSION
export const THUMB_DIMENSION = 320
export const PHOTO_MIME = 'image/jpeg'
const PHOTO_QUALITY = 0.85
const THUMB_QUALITY = 0.72

const BLOB_ID = /^[0-9a-f]{64}$/
const HEIC_TYPE = /^image\/hei[cf](?:-sequence)?$/i
const HEIC_NAME = /\.(?:heic|heif)$/i
const IMAGE_NAME = /\.(?:jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i

/** Quarter turns, clockwise. */
export type Rotation = 0 | 90 | 180 | 270

export function normalizeRotation(deg: number | undefined): Rotation {
  const r = (((Math.round((deg ?? 0) / 90) * 90) % 360) + 360) % 360
  return r === 90 || r === 180 || r === 270 ? r : 0
}

/** The rotation after turning by `by` degrees (±90). */
export function turn(current: number | undefined, by: 90 | -90): Rotation {
  return normalizeRotation(normalizeRotation(current) + by)
}

export function isHeic(file: Blob & { name?: string }): boolean {
  return HEIC_TYPE.test(file.type) || (typeof file.name === 'string' && HEIC_NAME.test(file.name))
}

/** A file the photo pipeline accepts (by type, or by name when the platform gives no type). */
export function isPhotoFile(file: Blob & { name?: string }): boolean {
  if (file.type.startsWith('image/')) return true
  return file.type === '' && typeof file.name === 'string' && IMAGE_NAME.test(file.name)
}

/** Width and height that fit inside `max` px on the longest side, never upscaled. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

// ── Markdown references ────────────────────────────────────────────────────────────────────────────────

const IMAGE_REF = /!\[([^\]\n]*)\]\(cursus-blob:([0-9a-f]{64})\)/g

/** `cursus-blob:<h64>`: the string a synced segment's header lists in `blobRefs`. */
export function photoRef(blobId: string): string {
  if (!BLOB_ID.test(blobId)) throw new RangeError(`Not a blob id: ${blobId}`)
  return `cursus-blob:${blobId}`
}

/** The blob id inside a `cursus-blob:` reference, or null. */
export function blobIdOf(ref: string | undefined): string | null {
  const m = /^cursus-blob:([0-9a-f]{64})$/.exec(ref ?? '')
  return m?.[1] ?? null
}

/** Markdown image of a stored photo; the alt text is the caption (VoiceOver reads it). */
export function photoMarkdown(blobId: string, alt: string): string {
  const safe = alt
    .replace(/[[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `![${safe}](${photoRef(blobId)})`
}

/** Photos shown by a Markdown text, in order of appearance, each once. */
export function photosIn(md: string): { blobId: string; alt: string }[] {
  const seen = new Set<string>()
  const out: { blobId: string; alt: string }[] = []
  for (const m of md.matchAll(IMAGE_REF)) {
    const blobId = m[2] as string
    if (seen.has(blobId)) continue
    seen.add(blobId)
    out.push({ blobId, alt: m[1] ?? '' })
  }
  return out
}

/** Every stored file a Markdown text points at (images, sounds, links). */
export function blobIdsIn(md: string): string[] {
  return [...new Set([...md.matchAll(/cursus-blob:([0-9a-f]{64})/g)].map((m) => m[1] as string))]
}

/** Appends a photo to a Markdown text, on its own paragraph. */
export function withPhoto(md: string, blobId: string, alt: string): string {
  const image = photoMarkdown(blobId, alt)
  const trimmed = md.replace(/\s+$/, '')
  return trimmed === '' ? image : `${trimmed}\n\n${image}`
}

/** Removes every image of this photo from a Markdown text (and the blank lines it leaves). */
export function withoutPhoto(md: string, blobId: string): string {
  return md
    .replace(IMAGE_REF, (all, _alt: string, id: string) => (id === blobId ? '' : all))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Markdown reduced to readable text for a share sheet: images become their alt text. */
export function shareText(md: string): string {
  return md
    .replace(IMAGE_REF, (_all, alt: string) => alt)
    .replace(/<audio\b[^>]*>(?:\s*<\/audio>)?/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Pixels (browser only) ──────────────────────────────────────────────────────────────────────────────

export interface PreparedPhoto {
  blob: Blob
  width: number
  height: number
}

async function decode(file: Blob & { name?: string }): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch (cause) {
    // A HEIC photo this browser cannot decode (Chrome, Firefox): said as such, with what to do.
    throw new ImageError(isHeic(file) ? 'unsupported' : 'decode', `cannot decode image: ${String(cause)}`)
  }
}

async function encode(
  source: ImageBitmap,
  w: number,
  h: number,
  rotation: Rotation,
  quality: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const sideways = rotation === 90 || rotation === 270
  const cw = sideways ? h : w
  const ch = sideways ? w : h
  const canvas = new OffscreenCanvas(cw, ch)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ImageError('decode', '2d canvas unavailable')
  // JPEG has no transparency: a transparent screenshot lands on white, not black.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, cw, ch)
  ctx.imageSmoothingQuality = 'high'
  ctx.translate(cw / 2, ch / 2)
  ctx.rotate((rotation * Math.PI) / 180)
  ctx.drawImage(source, -w / 2, -h / 2, w, h)
  const blob = await canvas.convertToBlob({ type: PHOTO_MIME, quality })
  return { blob, width: cw, height: ch }
}

/**
 * Downscales to 2048 px on the longest side and re-encodes as JPEG on this device: HEIC becomes JPEG where the
 * browser decodes it, and the camera's metadata (location included) is not kept. Throws ImageError.
 */
export async function preparePhoto(file: Blob & { name?: string }): Promise<PreparedPhoto> {
  if (file.size > MAX_IMAGE_INPUT_BYTES) {
    throw new ImageError('too-large', `image is ${file.size} bytes, limit ${MAX_IMAGE_INPUT_BYTES}`)
  }
  if (!isPhotoFile(file) && !isHeic(file)) throw new ImageError('unsupported', `unsupported type "${file.type}"`)
  const bitmap = await decode(file)
  try {
    const size = fitWithin(bitmap.width, bitmap.height, PHOTO_MAX_DIMENSION)
    const out = await encode(bitmap, size.width, size.height, 0, PHOTO_QUALITY)
    if (out.blob.size > MAX_IMAGE_OUTPUT_BYTES) {
      throw new ImageError('too-large', `encoded photo is ${out.blob.size} bytes, limit ${MAX_IMAGE_OUTPUT_BYTES}`)
    }
    return out
  } finally {
    bitmap.close()
  }
}

/** The photo as it is shown: turned by `rotation`, at most `max` px (a fresh JPEG; the stored file is untouched). */
export async function renderPhoto(file: Blob, rotation: Rotation, max = PHOTO_MAX_DIMENSION): Promise<Blob> {
  const bitmap = await decode(file)
  try {
    const size = fitWithin(bitmap.width, bitmap.height, max)
    return (await encode(bitmap, size.width, size.height, rotation, PHOTO_QUALITY)).blob
  } finally {
    bitmap.close()
  }
}

/** A small square-friendly preview (longest side 320 px). */
export async function makeThumbnail(file: Blob): Promise<Blob> {
  const bitmap = await decode(file)
  try {
    const size = fitWithin(bitmap.width, bitmap.height, THUMB_DIMENSION)
    return (await encode(bitmap, size.width, size.height, 0, THUMB_QUALITY)).blob
  } finally {
    bitmap.close()
  }
}

// ── Thumbnail cache (this device only, recomputable) ───────────────────────────────────────────────────

const THUMB_CACHE = 'cursus-thumbs-v1'
const thumbUrl = (blobId: string): string => `/__cursus-thumb__/${blobId}`
const memory = new Map<string, Blob>()

function cacheStorage(): CacheStorage | null {
  return typeof caches === 'undefined' ? null : caches
}

/**
 * Thumbnails live in the Cache API (evictable, never in the synced log nor in a backup); where it is
 * unavailable they live in memory for the page's life. Either way a missing one is simply recomputed.
 */
export const thumbnails = {
  async get(blobId: string): Promise<Blob | null> {
    const kept = memory.get(blobId)
    if (kept) return kept
    const storage = cacheStorage()
    if (!storage) return null
    const hit = await (await storage.open(THUMB_CACHE)).match(thumbUrl(blobId))
    if (!hit) return null
    const blob = await hit.blob()
    memory.set(blobId, blob)
    return blob
  },
  async put(blobId: string, thumb: Blob): Promise<void> {
    memory.set(blobId, thumb)
    const storage = cacheStorage()
    if (!storage) return
    const cache = await storage.open(THUMB_CACHE)
    await cache.put(thumbUrl(blobId), new Response(thumb, { headers: { 'content-type': thumb.type } }))
  },
}

// ── "Photos on this device" (device setting, never synced) ────────────────────────────────────────────

export type PhotoMode = 'all' | 'on-demand'
/** Device-local key in the `kv` store (never the Y.Doc). */
export const PHOTO_MODE_KEY = 'photos:mode'

export async function readPhotoMode(store: LocalStore): Promise<PhotoMode> {
  const v = await store.read(['kv'], (tx) => tx.get<unknown>('kv', PHOTO_MODE_KEY))
  return v === 'on-demand' ? 'on-demand' : 'all'
}

export function writePhotoMode(store: LocalStore, mode: PhotoMode): Promise<void> {
  return store.commit([{ put: 'kv', key: PHOTO_MODE_KEY, value: mode }])
}

/** For the sync engine: files of this type wait on the destinations until they are opened. */
export async function keptOnDemand(store: LocalStore, mime: string): Promise<boolean> {
  return mime.startsWith('image/') && (await readPhotoMode(store)) === 'on-demand'
}
