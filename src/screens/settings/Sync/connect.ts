import type { Runtime } from '../../../app/workspaceContext.tsx'
import type { SyncEngineImpl } from '../../../core/sync/engine'
import {
  cloudkitAuthOptions,
  commit,
  type DestDraft,
  DestinationError,
  type DestRecord,
  saveDraft,
  vault,
} from './registry.ts'

export { clearOAuthParam, commit, finishOAuth, pendingOAuthKey } from '../../../app/destinations.ts'

/** Where every provider sends the user back (public/oauth-callback.html, next to the app). */
export const redirectUri = (): string => new URL('oauth-callback.html', document.baseURI).href

/** Starts a Google Drive or Dropbox consent: returns the URL to leave for (the log is sealed first). */
export async function beginOAuth(rt: Runtime, r: Extract<DestDraft, { kind: 'gdrive' | 'dropbox' }>): Promise<string> {
  let url: string
  if (r.kind === 'gdrive') {
    const { beginAuth } = await import('../../../core/sync/providers/gdriveAuth')
    url = await beginAuth({
      client: { clientId: r.clientId, ...(r.clientSecret ? { clientSecret: r.clientSecret } : {}) },
      redirectUri: redirectUri(),
      rng: rt.rng,
      secrets: vault(rt),
      secretName: r.secretName,
      seal: () => rt.seal(),
    })
  } else {
    const { beginDropbox } = await import('../../../core/sync/providers/dropboxAuth')
    url = await beginDropbox({
      clientId: r.clientId,
      redirectUri: redirectUri(),
      secrets: vault(rt),
      name: r.secretName,
      seal: () => rt.seal(),
    })
  }
  const state = new URL(url).searchParams.get('state')
  if (!state) throw new DestinationError('errNoState')
  await saveDraft(rt, state, r)
  return url
}

/** CloudKit sign-in page, or null when this device already holds a valid token. */
export async function cloudkitSignIn(
  rt: Runtime,
  r: Extract<DestRecord, { kind: 'cloudkit' }>,
): Promise<string | null> {
  const { cloudkitAuth } = await import('../../../core/sync/providers/cloudkitAuth')
  return cloudkitAuth(cloudkitAuthOptions(rt, r)).signInUrl()
}

/** Lets the user pick a folder (Chromium) and remembers its handle for this destination. */
export async function pickFolder(
  rt: Runtime,
  engine: SyncEngineImpl,
  kind: 'folder' | 'icloud',
  label: string,
): Promise<DestRecord> {
  const picker = (window as unknown as { showDirectoryPicker?: (o: { mode: 'readwrite' }) => Promise<unknown> })
    .showDirectoryPicker
  if (!picker) throw new DestinationError('errNoFolders')
  const { FsStore, idbFsPersist } = await import('../../../core/sync/providers/fs')
  type Root = ConstructorParameters<typeof FsStore>[0]['root']
  const root = (await picker.call(window, { mode: 'readwrite' })) as Root
  const persist = idbFsPersist(rt.store)
  const id = new FsStore({ root, persist, type: kind, label }).id
  await persist.saveHandle(id, root)
  return commit(rt, engine, kind === 'folder' ? { kind: 'folder', label, id } : { kind: 'icloud', label, id })
}

export const folderSupported = (): boolean => 'showDirectoryPicker' in window
