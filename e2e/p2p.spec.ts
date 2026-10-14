import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { type BrowserContext, expect, type Page, test } from '@playwright/test'
import { decodeSignal, encodeSignal } from '../src/core/sync/p2p/signal.ts'

// Two devices are two browser contexts of the same chromium. Like content.spec.ts, the core
// modules are bundled into a throwaway harness served through Playwright routing.
const ROOT = resolve(import.meta.dirname, '..')
const HARNESS_BASE = '/cursus/__p2p-harness__/'
const ENTRY_ID = 'virtual:p2p-harness'
const ENTRY_CODE = `
import { hostPairing, joinPairing, newPairingCode } from '${ROOT}/src/core/sync/p2p/pairing.ts'
import { peerStore } from '${ROOT}/src/core/sync/p2p/peerStore.ts'
import { MemoryBucket, memoryRemote } from '${ROOT}/src/core/sync/providers/memory.ts'
window.harness = { hostPairing, joinPairing, newPairingCode, peerStore, MemoryBucket, memoryRemote }
`
const MIME: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' }

let outDir = ''
let entryFile = ''

test.use({ serviceWorkers: 'block' })

test.beforeAll(async () => {
  test.setTimeout(120_000)
  const { build } = await import('vite')
  outDir = await mkdtemp(join(tmpdir(), 'cursus-p2p-'))
  const result = await build({
    configFile: false,
    root: ROOT,
    base: HARNESS_BASE,
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true, target: 'es2022', minify: false, rollupOptions: { input: ENTRY_ID } },
    plugins: [
      {
        name: 'p2p-harness',
        resolveId: (id) => (id === ENTRY_ID ? `\0${ENTRY_ID}` : null),
        load: (id) => (id === `\0${ENTRY_ID}` ? ENTRY_CODE : null),
      },
    ],
  })
  for (const output of [result].flat()) {
    if (!('output' in output)) continue
    for (const file of output.output) if (file.type === 'chunk' && file.isEntry) entryFile = file.fileName
  }
  expect(entryFile).not.toBe('')
})

test.afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true })
})

async function openHarness(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.route(
    (url) => url.pathname.startsWith(HARNESS_BASE),
    async (route) => {
      const path = new URL(route.request().url()).pathname.slice(HARNESS_BASE.length)
      if (path === '' || path === 'index.html') {
        const html = `<!doctype html><meta charset="utf-8"><title>harness</title><script type="module" src="${HARNESS_BASE}${entryFile}"></script>`
        return route.fulfill({ status: 200, contentType: 'text/html', body: html })
      }
      try {
        const body = await readFile(join(outDir, path))
        return route.fulfill({ status: 200, contentType: MIME[extname(path)] ?? 'application/octet-stream', body })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return route.fulfill({ status: 404, body: 'not found' })
      }
    },
  )
  await page.goto(HARNESS_BASE)
  await page.waitForFunction(() => 'harness' in window)
  return page
}

type Harness = {
  hostPairing: typeof import('../src/core/sync/p2p/pairing.ts').hostPairing
  joinPairing: typeof import('../src/core/sync/p2p/pairing.ts').joinPairing
  newPairingCode: typeof import('../src/core/sync/p2p/pairing.ts').newPairingCode
  peerStore: typeof import('../src/core/sync/p2p/peerStore.ts').peerStore
  MemoryBucket: typeof import('../src/core/sync/providers/memory.ts').MemoryBucket
  memoryRemote: typeof import('../src/core/sync/providers/memory.ts').memoryRemote
}
type Device = Window & {
  harness: Harness
  host?: Awaited<ReturnType<Harness['hostPairing']>>
  link?: Promise<import('../src/core/sync/p2p/pairing.ts').PeerLink>
  store?: import('../src/core/sync/p2p/peerStore.ts').PeerStore
}

// Stands in for the LAN's Bonjour resolver: Playwright's WebKit only offers mDNS `<uuid>.local`
// host candidates and cannot resolve another page's names, so the relay maps them to loopback.
// Signals without .local candidates (Chromium) come back unchanged.
function resolveMdns(signal: string): string {
  const m = decodeSignal(signal)
  const candidates = m.candidates.map((c) => (c.address.endsWith('.local') ? { ...c, address: '127.0.0.1' } : c))
  return encodeSignal({ ...m, candidates })
}

async function pair(hostPage: Page, guestPage: Page, guestCode?: string) {
  const { code, offer } = await hostPage.evaluate(async () => {
    const w = window as unknown as Device
    const code = w.harness.newPairingCode()
    w.host = await w.harness.hostPairing({ RTCPeerConnection }, code)
    return { code, offer: w.host.offer }
  })
  const answer = await guestPage.evaluate(
    async ([offer, code]) => {
      const w = window as unknown as Device
      const joined = await w.harness.joinPairing({ RTCPeerConnection }, code, offer)
      w.link = joined.link
      w.link.catch(() => undefined)
      return joined.answer
    },
    [resolveMdns(offer), guestCode ?? code] as const,
  )
  return { offer, answer: resolveMdns(answer) }
}

test('two nearby devices pair, hand over secrets and sync through a PeerStore', async ({ browser }) => {
  const [ctxA, ctxB] = [await browser.newContext(), await browser.newContext()]
  const [a, b] = [await openHarness(ctxA), await openHarness(ctxB)]
  const { offer, answer } = await pair(a, b)
  expect(offer.length).toBeLessThan(400)
  expect(answer.length).toBeLessThan(400)

  const guestDone = b.evaluate(async () => {
    const w = window as unknown as Device
    const link = await (w.link as NonNullable<Device['link']>)
    const bundle = await link.receiveBundle()
    const bucket = new w.harness.MemoryBucket()
    w.store = w.harness.peerStore(link.frames, { id: 'peer:host', serve: w.harness.memoryRemote({ bucket }) })
    return bundle
  })
  await a.evaluate(async (answer) => {
    const w = window as unknown as Device
    const link = await (w.host as NonNullable<Device['host']>).complete(answer)
    link.sendBundle({ destinations: [{ kind: 's3', bucket: 'b' }], secrets: { 's3:b': 'token' } })
    w.store = w.harness.peerStore(link.frames, { id: 'peer:guest' })
  }, answer)
  expect(await guestDone).toEqual({ destinations: [{ kind: 's3', bucket: 'b' }], secrets: { 's3:b': 'token' } })

  const result = await a.evaluate(async () => {
    const w = window as unknown as Device
    const store = w.store as NonNullable<Device['store']>
    const big = new Uint8Array(1024 * 1024).map((_, i) => i % 253)
    await store.put('seg/d/0000000000-0123456789abcdef.seg', big)
    await store.put('fmt/v1', new TextEncoder().encode('cursus/1\n'))
    const keys: string[] = []
    for await (const e of store.list('')) keys.push(e.key)
    const back = await store.get({ key: 'seg/d/0000000000-0123456789abcdef.seg' })
    const same = back !== null && back.length === big.length && back.every((v, i) => v === big[i])
    return { keys, same, missing: await store.get({ key: 'nope' }) }
  })
  expect(result).toEqual({ keys: ['fmt/v1', 'seg/d/0000000000-0123456789abcdef.seg'], same: true, missing: null })
  await ctxA.close()
  await ctxB.close()
})

test('a guest with the wrong code is refused', async ({ browser }) => {
  const [ctxA, ctxB] = [await browser.newContext(), await browser.newContext()]
  const [a, b] = [await openHarness(ctxA), await openHarness(ctxB)]
  const { answer } = await pair(a, b, 'ZZZZ-ZZZZ-ZZZZZ')
  const [hostErr, guestErr] = await Promise.all([
    a.evaluate(async (answer) => {
      const w = window as unknown as Device
      try {
        await (w.host as NonNullable<Device['host']>).complete(answer)
        return 'paired'
      } catch (e) {
        return String(e)
      }
    }, answer),
    b.evaluate(async () => {
      const w = window as unknown as Device
      try {
        await w.link
        return 'paired'
      } catch (e) {
        return String(e)
      }
    }),
  ])
  expect(hostErr).toContain('pairing code')
  expect(guestErr).not.toBe('paired')
  await ctxA.close()
  await ctxB.close()
})
