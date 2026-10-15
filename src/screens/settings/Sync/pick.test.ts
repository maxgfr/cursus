import { expect, test } from 'bun:test'
import { recommended } from './pick.ts'

test('a Mac browser that keeps folders gets iCloud Drive; iPad, iPhone and Safari get the backup file', () => {
  expect(recommended({ folders: true, mac: true })).toBe('icloud')
  expect(recommended({ folders: false, mac: true })).toBe('file')
  expect(recommended({ folders: false, mac: false })).toBe('file')
  expect(recommended({ folders: true, mac: false })).toBe('file')
})
