import { expect, test } from 'bun:test'
import { guardChunk, isTransient, type PageEnv, startResiliently } from './chunkGuard.ts'

/** A scripted environment: whether the page is leaving, online, and the armed foreground retry. */
function env(over: Partial<{ leaving: boolean; online: boolean }> = {}) {
  const state = { leaving: over.leaving ?? false, online: over.online ?? true, armed: [] as (() => void)[] }
  const e: PageEnv = {
    leaving: () => state.leaving,
    online: () => state.online,
    onNextForeground: (then) => state.armed.push(then),
  }
  return { env: e, state }
}

/** A start that fails with each given error in turn, then succeeds. */
function failing(...errors: unknown[]) {
  const calls = { n: 0 }
  const start = async () => {
    const e = errors[calls.n++]
    if (e !== undefined) throw e
  }
  return { start, calls }
}

const aborted = () => new TypeError('Importing a module script failed.')

test('an import aborted while the page unloads is ignored quietly', async () => {
  const { env: e } = env({ leaving: true })
  const reports: string[] = []
  await startResiliently(failing(aborted()).start, (where) => reports.push(where), e)
  expect(reports).toEqual([])
})

test('a transient failure is recorded and retried once on the next return to the foreground', async () => {
  const { env: e, state } = env()
  const { start, calls } = failing(aborted())
  const reports: unknown[] = []
  await startResiliently(start, (where, err) => reports.push([where, err]), e)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toEqual(['pwa.start', expect.any(TypeError)])
  expect(state.armed).toHaveLength(1)
  state.armed[0]?.()
  await Promise.resolve()
  expect(calls.n).toBe(2)
  expect(reports).toHaveLength(1)
})

test('the retry happens only once: a second failure is recorded and not retried again', async () => {
  const { env: e, state } = env()
  const { start, calls } = failing(aborted(), aborted())
  const reports: string[] = []
  await startResiliently(start, (where) => reports.push(where), e)
  state.armed.shift()?.()
  await new Promise((r) => setTimeout(r, 0))
  expect(calls.n).toBe(2)
  expect(reports).toEqual(['pwa.start', 'pwa.start'])
  expect(state.armed).toEqual([])
})

test('a real (non-transient) failure is recorded and not retried', async () => {
  const { env: e, state } = env()
  const reports: string[] = []
  await startResiliently(failing(new DOMException('denied', 'SecurityError')).start, (where) => reports.push(where), e)
  expect(reports).toEqual(['pwa.start'])
  expect(state.armed).toEqual([])
})

test('a success records nothing', async () => {
  const { env: e, state } = env()
  const reports: string[] = []
  await startResiliently(failing().start, (where) => reports.push(where), e)
  expect(reports).toEqual([])
  expect(state.armed).toEqual([])
})

test('load failures and anything while offline are transient; other errors are not', () => {
  expect(isTransient(new TypeError('Failed to fetch dynamically imported module: https://x/a.js'), true)).toBe(true)
  expect(isTransient(new TypeError('error loading dynamically imported module'), true)).toBe(true)
  expect(isTransient(aborted(), true)).toBe(true)
  expect(isTransient(new TypeError('Load failed'), true)).toBe(true)
  expect(isTransient(new Error('boom'), false)).toBe(true)
  expect(isTransient(new Error('boom'), true)).toBe(false)
  expect(isTransient(new TypeError('x is not a function'), true)).toBe(false)
})

test('a chunk that fails outside navigation is recorded and rejects (the caller shows its retry)', async () => {
  const { env: e, state } = env()
  const reports: string[] = []
  const err = aborted()
  await expect(
    guardChunk(
      () => Promise.reject(err),
      'screen.stats',
      (w) => reports.push(w),
      e,
    ),
  ).rejects.toBe(err)
  expect(reports).toEqual(['screen.stats'])
  expect(state.armed).toEqual([])
})

test('a chunk aborted by navigation is not recorded and stays pending; back in the foreground it loads again', async () => {
  const { env: e, state } = env({ leaving: true })
  const reports: string[] = []
  let n = 0
  const load = () => (n++ === 0 ? Promise.reject(aborted()) : Promise.resolve('module'))
  let settled: unknown = 'pending'
  void guardChunk(load, 'screen.stats', (w) => reports.push(w), e).then((m) => {
    settled = m
  })
  await new Promise((r) => setTimeout(r, 0))
  expect(settled).toBe('pending')
  expect(reports).toEqual([])
  state.armed.shift()?.()
  await new Promise((r) => setTimeout(r, 0))
  expect(settled).toBe('module')
  expect(reports).toEqual([])
})
