import { createReadStream } from 'node:fs'
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { test as base } from '@playwright/test'
import { returningDevice } from './page.ts'

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
  /**
   * Publishes a "new version": same worker code, different bytes. With `commit`, a new build as a real deploy
   * makes it: the build identity (Settings › General) changes, so do the names of the chunks that hold or
   * import it, index.html and the precache manifest.
   */
  publishNewVersion: (next?: { commit: string }) => Promise<void>
}

/** The build identity as the minifier writes it (src/app/buildInfo.ts, filled by vite.config.ts `define`). */
const COMMIT = /commit:([`"'])([0-9a-f]{7,40}|dev)\1/

/**
 * Rewrites the copy as the next build: the chunk holding the build identity, then every chunk importing a
 * renamed one, get new names (as content hashes would), index.html points at them, and the precache manifest
 * lists them. Old files stay, as on a real host. Returns the new worker script.
 */
async function rebuild(root: string, worker: string, commit: string): Promise<string> {
  const assets = join(root, 'assets')
  const code = new Map<string, string>()
  for (const name of await readdir(assets))
    if (name.endsWith('.js')) code.set(name, await readFile(join(assets, name), 'utf8'))
  const renamed = new Map<string, string>()
  const rename = (name: string) => renamed.set(name, name.replace(/\.js$/, `.${commit}.js`))
  for (const [name, text] of code) {
    if (!COMMIT.test(text)) continue
    code.set(
      name,
      text.replace(COMMIT, (_m, q: string) => `commit:${q}${commit}${q}`),
    )
    rename(name)
  }
  if (renamed.size === 0) throw new Error('No chunk holds the build identity')
  for (let grew = true; grew; ) {
    grew = false
    for (const [name, text] of code) {
      if (renamed.has(name) || ![...renamed.keys()].some((old) => text.includes(old))) continue
      rename(name)
      grew = true
    }
  }
  const relink = (text: string) => {
    let out = text
    for (const [old, now] of renamed) out = out.replaceAll(old, now)
    return out
  }
  let manifest = worker
  for (const [old, now] of renamed) {
    await writeFile(join(assets, now), relink(code.get(old) ?? ''))
    const entry = `{url:"assets/${old}",revision:null}`
    if (!manifest.includes(entry)) throw new Error(`${old} is not precached as expected`)
    manifest = manifest.replace(entry, `{url:"assets/${now}",revision:null}`)
  }
  const html = join(root, 'index.html')
  await writeFile(html, relink(await readFile(html, 'utf8')))
  const page = /\{url:"index\.html",revision:"[^"]*"\}/
  if (!page.test(manifest)) throw new Error('index.html is not precached as expected')
  return manifest.replace(page, `{url:"index.html",revision:"${commit}"}`)
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
    publishNewVersion: async (next) => {
      let worker = await readFile(sw, 'utf8')
      if (next) worker = await rebuild(root, worker, next.commit)
      await writeFile(sw, `${worker}\n// next version\n`)
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
  storageState: async ({ ownApp }, use) => {
    await use(returningDevice(ownApp.url))
  },
})
