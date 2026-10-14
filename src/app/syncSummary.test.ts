import { describe, expect, test } from 'bun:test'
import type { EngineStatus } from '../core/sync/status'
import { summarize } from './syncSummary.ts'

const protectedOnOne: EngineStatus = {
  dests: [{ id: 'd', label: 'D', state: 'ok', unconfirmed: 0, incoming: 0, corrupt: 0 }],
  unsealed: 0,
  needsUpgrade: 0,
  safe: true,
  alarm: false,
  protectedOn: 1,
  unsaved: 0,
}
const saved = { unsaved: 0, blocked: false, versionChanged: false }

describe('summarize', () => {
  test('verified and nothing local since: protected', () => {
    expect(summarize(protectedOnOne, saved, true, null, false)).toEqual({ kind: 'protected', count: 1 })
  })

  test('an edit waiting for the local log is never protected', () => {
    expect(summarize(protectedOnOne, { ...saved, unsaved: 1 }, true, null, false).kind).not.toBe('protected')
  })

  test('a local change newer than the cached status is never protected', () => {
    expect(summarize(protectedOnOne, saved, true, null, true)).toEqual({ kind: 'syncing' })
  })

  test('offline with a newer local change says offline, not protected', () => {
    expect(summarize(protectedOnOne, saved, false, null, true)).toEqual({ kind: 'offline' })
  })
})
