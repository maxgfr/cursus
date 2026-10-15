import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { pwaOptions } from './pwa.config.ts'
import { FORMAT_VERSION, READABLE_VERSIONS } from './src/core/log/codec.ts'

const base = process.env.VITE_BASE ?? '/cursus/'

/**
 * The on-device model's engine (WebLLM, bundled into its worker, ~2 MB gzip) is not precached: most
 * installs never download a model. The service worker caches it the first time the engine starts, under
 * a `cursus-` name, so a downloaded model keeps working offline. One entry: a new version replaces the old.
 * The engine's model libraries and weights are not app files: WebLLM caches them itself (cursus-webllm/*).
 */
const LOCAL_ENGINE = 'assets/localModel.worker-*.js'
const LOCAL_ENGINE_CACHE = 'cursus-local-engine'

function withLocalEngineAtRuntime(options: ReturnType<typeof pwaOptions>): ReturnType<typeof pwaOptions> {
  const workbox = options.workbox ?? {}
  return {
    ...options,
    workbox: {
      ...workbox,
      globIgnores: [...(workbox.globIgnores ?? []), `**/${LOCAL_ENGINE}`],
      runtimeCaching: [
        ...(workbox.runtimeCaching ?? []),
        {
          urlPattern: /\/assets\/localModel\.worker-[\w-]+\.js$/,
          handler: 'CacheFirst',
          options: {
            cacheName: LOCAL_ENGINE_CACHE,
            expiration: { maxEntries: 1 },
            cacheableResponse: { statuses: [200] },
          },
        },
      ],
    },
  }
}

/** Runs a git command; null where git or the answer is unavailable (a source tarball, a shallow clone). */
function git(args: string): string | null {
  try {
    const out = execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    return out || null
  } catch {
    return null
  }
}

/** The release built: CI's `APP_VERSION` (from the semantic-release tag), else the latest tag, else `0.0.0-dev`. */
const version = process.env.APP_VERSION || git('describe --tags --abbrev=0')?.replace(/^v/, '') || '0.0.0-dev'
/** The short commit built: CI's `GITHUB_SHA`, else git's HEAD, else `dev`. */
const commit = process.env.GITHUB_SHA?.slice(0, 7) || git('rev-parse --short HEAD') || 'dev'

export default defineConfig({
  base,
  // What Settings › General shows as this build (src/app/buildInfo.ts); the sync format comes from the codec.
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
    __APP_FORMAT__: JSON.stringify({ writes: FORMAT_VERSION, reads: READABLE_VERSIONS }),
  },
  plugins: [react(), VitePWA(withLocalEngineAtRuntime(pwaOptions(base)))],
  build: { target: 'es2022' },
})
