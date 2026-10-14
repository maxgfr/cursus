import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { expect, type Page } from '@playwright/test'

// Seeding without a test path in the app: a throwaway harness (the approach of review.spec.ts) opens
// the same local log on the app's origin and writes through the Workspace, exactly as the app does:
// capture into the log, then seal. It never touches the Y.Doc directly.
const ROOT = resolve(import.meta.dirname, '..', '..')
const HARNESS_BASE = '/cursus/__matrix-harness__/'
const ENTRY_ID = 'virtual:matrix-harness'
const ENTRY_CODE = `
import * as Y from 'yjs'
import { idbStore } from '${ROOT}/src/core/storage/idbStore.ts'
import { createLocalLog } from '${ROOT}/src/core/log/localLog.ts'
import { captureUpdates, REPLAY } from '${ROOT}/src/core/log/origins.ts'
import { createWorkspace } from '${ROOT}/src/core/model/workspace.ts'
import { systemClock } from '${ROOT}/src/core/ports/clock.ts'
import { defaultLocks } from '${ROOT}/src/core/ports/locks.ts'
import { cryptoRng } from '${ROOT}/src/core/ports/rng.ts'

const DAY = 86400000

async function seed(spec) {
  const store = idbStore()
  const clock = systemClock
  const rng = cryptoRng(clock)
  const log = createLocalLog({ store, locks: defaultLocks(), clock, rng })
  const { updates } = await log.load()
  const doc = new Y.Doc()
  for (const u of updates) Y.applyUpdateV2(doc, u, REPLAY)
  const ws = createWorkspace(doc, { rng, clock, deviceId: await log.deviceId() })
  const capture = captureUpdates(doc, (u) => log.appendLocal(u))
  for (const c of spec.courses ?? []) {
    const courseId = ws.courses.create({ title: c.title, language: 'en' })
    for (const n of c.notes ?? []) {
      const id = ws.sources.create({ courseId, kind: 'note', title: n.title })
      ws.text({ id, field: 'body' }).insert(0, n.body)
    }
    for (const card of c.cards ?? []) {
      const id = ws.batch(() => {
        const id = ws.cards.create({ courseId, kind: 'basic' })
        ws.text({ id, field: 'front' }).insert(0, card.front)
        ws.text({ id, field: 'back' }).insert(0, card.back)
        return id
      })
      for (const r of card.reviews ?? []) ws.reviews.record({ cardId: id, rating: r.rating, at: r.at, ms: 4000 })
    }
  }
  if (spec.bulk) {
    // Generated here rather than shipped over the protocol: a large library with a long history.
    const { courses, cardsPerCourse, reviewsPerCard } = spec.bulk
    const now = clock.now()
    ws.batch(() => {
      for (let k = 0; k < courses; k++) {
        const courseId = ws.courses.create({ title: 'Course ' + (k + 1), language: 'en' })
        for (let i = 0; i < cardsPerCourse; i++) {
          const id = ws.cards.create({ courseId, kind: 'basic' })
          ws.text({ id, field: 'front' }).insert(0, 'Question ' + k + '.' + i + ': what is term ' + i + '?')
          ws.text({ id, field: 'back' }).insert(0, 'Answer ' + i)
          // Reviews spread over the past year; a fraction of them lapse.
          const start = now - 365 * DAY + ((i * 7919) % (30 * DAY))
          for (let j = 0; j < reviewsPerCard; j++) {
            const rating = (i + j) % 9 === 0 ? 1 : 3
            ws.reviews.record({ cardId: id, rating, at: start + j * 16 * DAY, ms: 4000 })
          }
        }
      }
    })
  }
  await capture.settled()
  await log.seal()
  capture.stop()
  // The iOS install hint was already dismissed on this device (device-local kv, never the doc).
  await store.commit([{ put: 'kv', key: 'pwa:install-hint-dismissed', value: Date.now() }])
  store.close()
}
window.harness = { seed }
`
const MIME: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' }

export interface SeedCard {
  front: string
  back: string
  reviews?: { rating: 1 | 2 | 3 | 4; at: number }[]
}
export interface SeedCourse {
  title: string
  notes?: { title: string; body: string }[]
  cards?: SeedCard[]
}
export interface SeedSpec {
  courses?: SeedCourse[]
  /** Generated in the page: `courses × cardsPerCourse` cards, each with `reviewsPerCard` reviews. */
  bulk?: { courses: number; cardsPerCourse: number; reviewsPerCard: number }
}

export interface Harness {
  /** Builds the harness bundle (once per worker, in `beforeAll`). */
  build(): Promise<void>
  /** Removes the bundle (in `afterAll`). */
  dispose(): Promise<void>
  /** Seeds the device behind `page` (leaving the page on the harness URL) and dismisses the install hint. */
  seed(page: Page, spec?: SeedSpec): Promise<void>
}

export function createHarness(): Harness {
  let outDir = ''
  let entryFile = ''
  return {
    async build() {
      const { build } = await import('vite')
      outDir = await mkdtemp(join(tmpdir(), 'cursus-matrix-'))
      const result = await build({
        configFile: false,
        root: ROOT,
        base: HARNESS_BASE,
        logLevel: 'warn',
        build: { outDir, emptyOutDir: true, target: 'es2022', minify: false, rollupOptions: { input: ENTRY_ID } },
        plugins: [
          {
            name: 'matrix-harness',
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
    },
    async dispose() {
      if (outDir) await rm(outDir, { recursive: true, force: true })
    },
    async seed(page, spec = {}) {
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
      await page.evaluate(
        (s) => (window as unknown as { harness: { seed(s: unknown): Promise<void> } }).harness.seed(s),
        spec,
      )
    },
  }
}
