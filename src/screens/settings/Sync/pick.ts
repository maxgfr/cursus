import type { DestKind } from './registry.ts'

export interface Device {
  /** The browser can keep a folder in sync (File System Access). */
  folders: boolean
  /** A Mac, not an iPad presenting itself as one. */
  mac: boolean
}

/** The destination to suggest first: an iCloud Drive folder where the browser can keep one, else an account that syncs on every device. */
export function recommended(d: Device): DestKind {
  return d.folders && d.mac ? 'icloud' : 'dropbox'
}

/** What this browser can do, read once. */
export function thisDevice(): Device {
  return {
    folders: 'showDirectoryPicker' in window,
    mac: /Mac/.test(navigator.userAgent) && navigator.maxTouchPoints <= 1,
  }
}
