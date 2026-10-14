import { expect, test } from 'bun:test'
import { recommended } from './pick.ts'

test('a Mac browser that keeps folders gets iCloud Drive; iPad, iPhone and Safari get an account synced everywhere', () => {
  expect(recommended({ folders: true, mac: true })).toBe('icloud')
  expect(recommended({ folders: false, mac: true })).toBe('dropbox')
  expect(recommended({ folders: false, mac: false })).toBe('dropbox')
  expect(recommended({ folders: true, mac: false })).toBe('dropbox')
})
