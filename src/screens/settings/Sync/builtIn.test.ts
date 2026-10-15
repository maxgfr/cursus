import { describe, expect, test } from 'bun:test'
import { appFolderDraft, builtInKeys, oneClickDraft } from './builtIn.ts'

describe('one-click providers', () => {
  test('with Cursus’s own key, Dropbox and OneDrive connect straight away in the app folder', () => {
    const keys = { dropbox: 'cursus-dropbox-key', onedrive: 'cursus-client-id' }
    expect(oneClickDraft('dropbox', keys)).toEqual({
      kind: 'dropbox',
      label: 'Dropbox',
      clientId: 'cursus-dropbox-key',
      root: '',
      secretName: 'dropbox:root',
    })
    expect(oneClickDraft('onedrive', keys)).toEqual({
      kind: 'onedrive',
      label: 'OneDrive',
      clientId: 'cursus-client-id',
      root: '',
      secretName: 'onedrive:root',
    })
  })

  test('without a key, or for other providers, the form asks for one', () => {
    expect(oneClickDraft('dropbox', { dropbox: ' ', onedrive: '' })).toBeNull()
    expect(oneClickDraft('onedrive', { dropbox: 'k', onedrive: '' })).toBeNull()
    expect(oneClickDraft('gdrive', { dropbox: 'k', onedrive: 'k' })).toBeNull()
    expect(oneClickDraft('s3', { dropbox: 'k', onedrive: 'k' })).toBeNull()
  })

  test('the shipped keys decide the default (empty until the maintainer fills them)', () => {
    expect(oneClickDraft('dropbox') === null).toBe(builtInKeys.dropbox.trim() === '')
    expect(oneClickDraft('onedrive') === null).toBe(builtInKeys.onedrive.trim() === '')
  })

  test('a subfolder names the destination and its tokens', () => {
    expect(appFolderDraft('onedrive', ' id ', ' Med ')).toEqual({
      kind: 'onedrive',
      label: 'OneDrive · Med',
      clientId: 'id',
      root: 'Med',
      secretName: 'onedrive:Med',
    })
  })
})
