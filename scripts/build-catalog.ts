// Build-time only: llm-models is not browser-safe, so it is run here and reduced to src/core/ai/catalog.json.
import { writeFile } from 'node:fs/promises'
import { listProviders, setCacheEnabled } from 'llm-models'
import { type Catalog, keepProvider, providerBaseUrl, trimProvider } from '../src/core/ai/catalogTrim'

const ORIGIN = 'https://maxgfr.github.io'
const OUT = new URL('../src/core/ai/catalog.json', import.meta.url)
const BUDGET = 300 * 1024
/** Newest models kept per provider, so aggregators re-listing everything stay within budget. */
const PER_PROVIDER = 5

/** Endpoint and request headers the client really sends, per wire protocol. */
const PROBES: Record<string, { path: string; headers: string }> = {
  anthropic: {
    path: '/messages',
    headers: 'anthropic-dangerous-direct-browser-access,anthropic-version,content-type,x-api-key',
  },
  google: { path: '/models/gemini-pro:generateContent', headers: 'content-type,x-goog-api-key' },
}
const DEFAULT_PROBE = { path: '/chat/completions', headers: 'authorization,content-type' }

async function probeCors(providerId: string, baseUrl: string): Promise<boolean> {
  const probe = PROBES[providerId] ?? DEFAULT_PROBE
  const url = `${baseUrl.replace(/\/+$/, '')}${probe.path}`
  try {
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': probe.headers,
      },
      signal: AbortSignal.timeout(10_000),
    })
    const allow = res.headers.get('access-control-allow-origin')
    return res.status < 500 && (allow === '*' || allow === ORIGIN)
  } catch (e) {
    console.warn(`CORS probe failed for ${url}: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

setCacheEnabled(false)
const providers = (await listProviders()).filter(keepProvider)
const trimmed = await Promise.all(
  providers.map(async (p) => {
    const base = providerBaseUrl(p)
    const callable = base ? await probeCors(p.id, base) : false
    // Models of providers a browser cannot reach are useless to the PWA: keep the provider, drop its models.
    if (!callable) return { ...trimProvider(p, false), models: [] }
    const full = trimProvider(p, true)
    const newest = full.models
      .filter((m) => m.modalities.input.includes('text'))
      .sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))
    return { ...full, models: newest.slice(0, PER_PROVIDER) }
  }),
)
const catalog: Catalog = {
  generatedAt: new Date().toISOString(),
  providers: trimmed.sort((a, b) => a.id.localeCompare(b.id)),
}
await writeFile(OUT, JSON.stringify(catalog))
// The committed file follows the repo's formatter, so the budget applies to that form.
const fmt = Bun.spawnSync(['bunx', 'biome', 'format', '--write', OUT.pathname], { stdout: 'ignore', stderr: 'inherit' })
if (fmt.exitCode !== 0) throw new Error(`biome format exited with ${fmt.exitCode}`)
const size = Bun.file(OUT).size
if (size > BUDGET) throw new Error(`catalog.json is ${size} bytes, over the ${BUDGET} byte budget`)
const models = catalog.providers.reduce((n, p) => n + p.models.length, 0)
const callable = catalog.providers.filter((p) => p.browserCallable).length
console.log(
  `catalog.json: ${models} models, ${catalog.providers.length} providers (${callable} browser-callable), ${size} bytes`,
)
