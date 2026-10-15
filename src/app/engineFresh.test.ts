import { expect, test } from 'bun:test'
import type { PageEnv } from './chunkGuard.ts'
import { keepEngineFresh } from './engineFresh.ts'

const page = (leaving: boolean): PageEnv => ({
  leaving: () => leaving,
  online: () => true,
  onNextForeground: () => {},
})

/** WebKit's words for a module load the page's own navigation cut short. */
const aborted = () => new TypeError('Importing a module script failed.')

function harness(load: () => Promise<{ keepEngineFresh(): Promise<void> }>, reloading = false) {
  const said = { reports: [] as string[], failures: [] as unknown[], loads: 0 }
  const run = (env: PageEnv) =>
    keepEngineFresh({
      load: () => {
        said.loads++
        return load()
      },
      reloading: () => reloading,
      report: (where) => said.reports.push(where),
      fail: (e) => said.failures.push(e),
      env,
    })
  return { said, run }
}

test('nothing is loaded while an update is reloading the page', async () => {
  const { said, run } = harness(() => Promise.resolve({ keepEngineFresh: async () => {} }), true)
  await run(page(false))
  expect(said.loads).toBe(0)
  expect(said.failures).toEqual([])
})

test('a load the reload aborts is the reload itself: neither recorded nor said', async () => {
  const { said, run } = harness(() => Promise.reject(aborted()))
  void run(page(true))
  await new Promise((r) => setTimeout(r, 0))
  expect(said.loads).toBe(1)
  expect(said.reports).toEqual([])
  expect(said.failures).toEqual([])
})

test('a real load failure is still recorded and said', async () => {
  const { said, run } = harness(() => Promise.reject(aborted()))
  await run(page(false))
  expect(said.reports).toEqual(['chunk.onDeviceStore'])
  expect(said.failures).toEqual([expect.any(TypeError)])
})

test('a failure storing the engine is said', async () => {
  const boom = new Error('quota')
  const { said, run } = harness(() =>
    Promise.resolve({
      keepEngineFresh: () => Promise.reject(boom),
    }),
  )
  await run(page(false))
  expect(said.reports).toEqual([])
  expect(said.failures).toEqual([boom])
})

test('the engine is kept fresh once loaded', async () => {
  let kept = 0
  const { said, run } = harness(() =>
    Promise.resolve({
      keepEngineFresh: async () => {
        kept++
      },
    }),
  )
  await run(page(false))
  expect(kept).toBe(1)
  expect(said.failures).toEqual([])
})
