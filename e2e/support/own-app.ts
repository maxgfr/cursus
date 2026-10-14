import { createReadStream } from 'node:fs'
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { test as base } from '@playwright/test'

const DIST = join(import.meta.dirname, '..', '..', 'dist')
const BASE = process.env.VITE_BASE ?? '/cursus/'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

/** A private copy of the built app, served on its own origin: publishing a new version here never touches dist/. */
export type OwnApp = {
  /** The app's base URL on this private origin (ends with the base path). */
  url: string
  /** Publishes a "new version": same worker code, different bytes. */
  publishNewVersion: () => Promise<void>
}

async function serveCopy(): Promise<OwnApp & { close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'cursus-app-'))
  await cp(DIST, root, { recursive: true })
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    if (!path.startsWith(BASE)) {
      res.writeHead(path === BASE.slice(0, -1) ? 301 : 404, { Location: BASE }).end()
      return
    }
    const rel = normalize(path.slice(BASE.length) || 'index.html')
    const file = join(root, rel)
    if (rel.startsWith('..') || !file.startsWith(root + sep)) {
      res.writeHead(403).end()
      return
    }
    const found = await stat(file).then(
      (s) => s.isFile(),
      () => false,
    )
    if (!found) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    createReadStream(file).pipe(res)
  })
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
  const { port } = server.address() as AddressInfo
  const sw = join(root, 'sw.js')
  return {
    url: `http://localhost:${port}${BASE}`,
    publishNewVersion: async () => {
      await writeFile(sw, `${await readFile(sw, 'utf8')}\n// next version\n`)
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** Tests that publish a new version: each one runs against its own copy of the app (the page's baseURL points there). */
export const test = base.extend<{ ownApp: OwnApp }>({
  ownApp: async ({ browserName: _browserName }, use) => {
    const app = await serveCopy()
    try {
      await use(app)
    } finally {
      await app.close()
    }
  },
  baseURL: async ({ ownApp }, use) => {
    await use(ownApp.url)
  },
})
