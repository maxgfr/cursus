import { DROPBOX_APP_KEY, ONEDRIVE_CLIENT_ID } from '../../../app/oauthApps.ts'
import type { DestDraft, DestKind } from './registry.ts'

/** The app keys Cursus ships, per provider (empty while not set up). */
export interface BuiltInKeys {
  dropbox: string
  onedrive: string
}

export const builtInKeys: BuiltInKeys = { dropbox: DROPBOX_APP_KEY, onedrive: ONEDRIVE_CLIENT_ID }

/** A provider connected in its app folder (`root` optional, inside it). */
export function appFolderDraft(kind: 'dropbox' | 'onedrive', clientId: string, root = ''): DestDraft {
  const name = kind === 'dropbox' ? 'Dropbox' : 'OneDrive'
  const r = root.trim()
  return {
    kind,
    label: r ? `${name} · ${r}` : name,
    clientId: clientId.trim(),
    root: r,
    secretName: `${kind}:${r || 'root'}`,
  }
}

/**
 * What a provider row connects at once, with Cursus's own key: a draft for the consent page, or null when
 * the student must bring their own key (the form then opens).
 */
export function oneClickDraft(kind: DestKind, keys: BuiltInKeys = builtInKeys): DestDraft | null {
  if (kind !== 'dropbox' && kind !== 'onedrive') return null
  const key = keys[kind].trim()
  return key ? appFolderDraft(kind, key) : null
}
