import type { DestKind } from './registry.ts'

export interface Device {
  /** The browser can keep a folder in sync (File System Access). */
  folders: boolean
  /** A Mac, not an iPad presenting itself as one. */
  mac: boolean
}

/**
 * What to suggest first: an iCloud Drive folder where the browser can keep one, else the backup file. Google
 * Drive and Dropbox need the student's own app key (Cursus ships none), so they are never the first suggestion.
 */
export function recommended(d: Device): DestKind | 'file' {
  return d.folders && d.mac ? 'icloud' : 'file'
}

/** What this browser can do, read once. */
export function thisDevice(): Device {
  return {
    folders: 'showDirectoryPicker' in window,
    mac: /Mac/.test(navigator.userAgent) && navigator.maxTouchPoints <= 1,
  }
}
