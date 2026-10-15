import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { LocalStore } from '../contracts/ports'
import type { ReplaySnapshot } from './fsrs'
import { readSavedReplays } from './savedReplays'

const SNAP: ReplaySnapshot = { v: 1, params: 'p', ids: [], lastIds: [], phases: [], nums: new Float64Array(0) }

/** A store whose kv read resolves with `value` after `ms`, rejects with `error`, or never settles. */
function storeReading(o: {
  value?: ReplaySnapshot
  ms?: number
  error?: Error
  never?: boolean
}): Pick<LocalStore, 'read'> {
  return {
    read<T>(): Promise<T> {
      if (o.never === true) return new Promise<T>(() => undefined)
      if (o.error) return Promise.reject(o.error)
      return new Promise<T>((resolve) => setTimeout(() => resolve(o.value as T), o.ms ?? 0))
    },
  }
}

describe('saved replays', () => {
  const spies: { mockRestore(): void }[] = []
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore()
  })

  test('a read that takes a while within the bound still gives the snapshot', async () => {
    expect(await readSavedReplays(storeReading({ value: SNAP, ms: 30 }), 1_000)).toBe(SNAP)
  })

  test('none saved yet: null', async () => {
    expect(await readSavedReplays(storeReading({}), 1_000)).toBeNull()
  })

  test('an unreadable snapshot is logged and gives null (a full replay), never a failed launch', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    spies.push(error)
    expect(await readSavedReplays(storeReading({ error: new Error('quota') }), 1_000)).toBeNull()
    expect(error).toHaveBeenCalledTimes(1)
  })

  test('a read that never settles is given up after the bound: the launch never waits forever', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    spies.push(warn)
    const start = performance.now()
    expect(await readSavedReplays(storeReading({ never: true }), 40)).toBeNull()
    expect(performance.now() - start).toBeLessThan(1_000)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
