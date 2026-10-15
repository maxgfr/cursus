import { describe, expect, test } from 'bun:test'
import { canShareFiles, saveFile } from './saveFile.ts'

const bytes = new TextEncoder().encode('archive')

describe('saving a backup file', () => {
  test('the share sheet gets the file itself, named and typed', async () => {
    const shared: File[] = []
    const nav = {
      canShare: (d: ShareData) => (d.files ?? []).length === 1,
      share: async (d: ShareData) => {
        shared.push(...(d.files ?? []))
      },
    }
    expect(canShareFiles('application/vnd.cursus+zip', nav)).toBe(true)
    expect(await saveFile(bytes, 'cursus-2026-10-15.cursus', 'application/vnd.cursus+zip', nav)).toBe('shared')
    expect(shared[0]?.name).toBe('cursus-2026-10-15.cursus')
    expect(shared[0]?.type).toBe('application/vnd.cursus+zip')
    expect(new Uint8Array(await (shared[0] as File).arrayBuffer())).toEqual(bytes)
  })

  test('closing the sheet is a cancel; any other failure than a refused sheet is an error', async () => {
    const failing = (e: Error) => ({ canShare: () => true, share: () => Promise.reject(e) })
    expect(await saveFile(bytes, 'b.cursus', 't', failing(new DOMException('closed', 'AbortError')))).toBe('cancelled')
    await expect(saveFile(bytes, 'b.cursus', 't', failing(new DOMException('bad', 'DataError')))).rejects.toThrow('bad')
  })

  test('without file sharing, nothing is offered to share', () => {
    expect(canShareFiles('t', {})).toBe(false)
    expect(canShareFiles('t', { canShare: () => false, share: async () => undefined })).toBe(false)
  })
})
