import { expect, test } from 'bun:test'
import { probeWorker, type WorkerContainer } from './worker.ts'

/** A container whose `register` settles as given, and the calls it received. */
function container(register: () => Promise<unknown>) {
  const calls: [string, RegistrationOptions | undefined][] = []
  const c: WorkerContainer = {
    register: (url, options) => {
      calls.push([url, options])
      return register()
    },
  }
  return { c, calls }
}

test('no service worker container: unavailable, nothing registered', async () => {
  expect(await probeWorker(undefined, '/cursus/sw.js', '/cursus/')).toBe(false)
})

test('register resolving without a registration (blocked): unavailable, no error', async () => {
  const { c, calls } = container(async () => undefined)
  expect(await probeWorker(c, '/cursus/sw.js', '/cursus/')).toBe(false)
  expect(calls).toEqual([['/cursus/sw.js', { scope: '/cursus/' }]])
})

test('register refused for security (service workers disabled): unavailable, no error', async () => {
  const { c } = container(async () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  })
  expect(await probeWorker(c, '/cursus/sw.js', '/cursus/')).toBe(false)
})

test('a real registration failure still rejects', async () => {
  const failure = new TypeError('Failed to register a ServiceWorker: A bad HTTP response code (404) was received.')
  const { c } = container(async () => {
    throw failure
  })
  await expect(probeWorker(c, '/cursus/sw.js', '/cursus/')).rejects.toBe(failure)
})

test('a registration: available', async () => {
  const { c } = container(async () => ({ scope: 'https://example.test/cursus/' }))
  expect(await probeWorker(c, '/cursus/sw.js', '/cursus/')).toBe(true)
})
