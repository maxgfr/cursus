import { download } from '../Sync/registry.ts'

/** What saving a file did: handed to the share sheet (« Save to Files » on iPhone), downloaded, or cancelled. */
export type Saved = 'shared' | 'downloaded' | 'cancelled'

type ShareNav = Pick<Navigator, 'share'> & { canShare?: (data: ShareData) => boolean }

const probe = (type: string) => new File([new Uint8Array()], 'backup', { type })

/** The browser can hand a file of this type to the system share sheet (iPhone, iPad, Android). */
export function canShareFiles(type: string, nav: Partial<ShareNav> = navigator): boolean {
  return typeof nav.canShare === 'function' && typeof nav.share === 'function' && nav.canShare({ files: [probe(type)] })
}

/**
 * Hands the file to the share sheet where the browser can (« Save to Files » on iPhone), else downloads it.
 * Closing the sheet is a cancel, not a failure; a sheet refused for want of a fresh tap (the export took a
 * while) falls back to the download.
 */
export async function saveFile(
  bytes: Uint8Array,
  name: string,
  type: string,
  nav: Partial<ShareNav> = navigator,
): Promise<Saved> {
  const file = new File([new Uint8Array(bytes)], name, { type })
  if (typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file] })
      return 'shared'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) throw e
    }
  }
  download(bytes, name, type)
  return 'downloaded'
}
