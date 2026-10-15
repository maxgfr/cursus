import { photosIn, type Rotation, renderPhoto, shareText } from '../../core/content/photos'
import type { FileLoader } from '../../core/export/coursePackage'
import { download, safeName } from '../Stats/download.ts'

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled'

/**
 * The share sheet where the platform takes these files (iPhone, iPad, Safari on the Mac), otherwise a download.
 * `fallback` is what gets downloaded then (one file).
 */
async function shareOrDownload(
  data: { files: File[]; title: string; text?: string },
  fallback: File,
): Promise<ShareOutcome> {
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: data.files })) {
    try {
      await navigator.share(data)
      return 'shared'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      // The sheet refused (no user activation left after reading the file): download instead.
      console.warn('share failed, downloading instead', e)
    }
  }
  download(fallback.name, fallback)
  return 'downloaded'
}

/** A photo as it is shown (its rotation applied), named after its label. */
async function photoFile(blob: Blob, rotation: Rotation, label: string): Promise<File> {
  const shown = rotation === 0 ? blob : await renderPhoto(blob, rotation)
  return new File([shown], `${safeName(label, 'photo')}.jpg`, { type: 'image/jpeg' })
}

export async function sharePhoto(
  blob: Blob,
  photo: { rotation: Rotation; label: string; caption: string },
): Promise<ShareOutcome> {
  const file = await photoFile(blob, photo.rotation, photo.label)
  return shareOrDownload({ files: [file], title: photo.label, ...(photo.caption ? { text: photo.caption } : {}) }, file)
}

/**
 * A card and its photos: the text (front, then back) and the photos as files. Without a share sheet, a zip with
 * `card.md` and the photos is downloaded.
 */
export async function shareCard(
  card: { front: string; back: string; title: string },
  load: FileLoader,
): Promise<ShareOutcome> {
  const text = [shareText(card.front), shareText(card.back)].filter((s) => s !== '').join('\n\n')
  const files: File[] = []
  const names = new Map<string, string>()
  for (const p of [...photosIn(card.front), ...photosIn(card.back)]) {
    if (names.has(p.blobId)) continue
    const blob = await load(p.blobId)
    if (blob === null) continue
    const name = `photo-${files.length + 1}.jpg`
    names.set(p.blobId, name)
    files.push(new File([blob], name, { type: blob.type || 'image/jpeg' }))
  }
  const title = safeName(card.title, 'card')
  const md = `${card.front}\n\n---\n\n${card.back}`.replace(
    /cursus-blob:([0-9a-f]{64})/g,
    (all, id: string) => names.get(id) ?? all,
  )
  if (files.length === 0) {
    const note = new File([md], `${title}.md`, { type: 'text/markdown' })
    return shareOrDownload({ files: [note], title: card.title, text }, note)
  }
  const { zipSync, strToU8 } = await import('fflate')
  const entries: Record<string, Uint8Array> = { 'card.md': strToU8(md) }
  for (const f of files) entries[f.name] = new Uint8Array(await f.arrayBuffer())
  const zip = new File([zipSync(entries)], `${title}.zip`, { type: 'application/zip' })
  return shareOrDownload({ files, title: card.title, text }, zip)
}
