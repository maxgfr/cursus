// Build-time only: llm-models is not browser-safe, so it is run here and reduced to src/core/ai/catalog.json.
import { writeFile } from 'node:fs/promises'
import { listProviders, probeBrowserSupportAll, providerBaseUrl, setCacheEnabled } from 'llm-models'
import {
  browserVerdict,
  buildCatalog,
  type Catalog,
  clientBaseUrl,
  clientPackage,
  encodeCatalog,
  isBrowserCallable,
  type ProviderFacts,
  type ProviderLike,
  unknownFacts,
} from '../src/core/ai/catalogTrim'

const ORIGIN = 'https://maxgfr.github.io'
const OUT = new URL('../src/core/ai/catalog.json', import.meta.url)
/** Gzipped bytes; the catalog is its own lazy chunk, fetched only by the AI screens. */
const BUDGET = 300 * 1024
/** Ids llm-models' probe maps to a non-OpenAI protocol. */
const NATIVE_IDS: ReadonlySet<string> = new Set(['anthropic', 'google', 'cohere'])

setCacheEnabled(false)
// llm-models' probe checks what a browser checks: a 2xx preflight, the origin, every header the call sends.
const providers = await listProviders()
/** Where the client will call each provider it can speak to, so the probe checks that same endpoint. */
const targets = providers.flatMap((p) => {
  const npm = clientPackage(p)
  const api = clientBaseUrl(p, providerBaseUrl({ id: p.id, api: p.api ?? null, npm: p.npm ?? null }))
  if (!npm || !api) return []
  // llm-models picks the wire protocol from the id as well as the package: an id it knows natively
  // (cohere) would be probed on its native endpoint, not the OpenAI-compatible one we call.
  const id = npm === '@ai-sdk/openai-compatible' && NATIVE_IDS.has(p.id) ? `${p.id}-openai-compatible` : p.id
  return [{ provider: p.id, target: { id, api, npm } }]
})
const support = await probeBrowserSupportAll(
  targets.map((t) => t.target),
  { origin: ORIGIN },
)
const targetOf = new Map(targets.map((t) => [t.provider, t.target]))
const facts = (p: ProviderLike): ProviderFacts => {
  const t = targetOf.get(p.id)
  const s = t ? support[t.id] : undefined
  const checkedAt = new Date().toISOString()
  return {
    api: t?.api ?? null,
    baseUrlSource: p.api && t?.api === p.api ? 'api' : t ? 'default' : 'none',
    browser: s ? browserVerdict(p.id, s) : unknownFacts(checkedAt).browser,
  }
}
// Every model of every kept provider: no per-provider cap. Blocked providers are recorded in `blocked`.
const catalog: Catalog = buildCatalog(providers, facts, new Date().toISOString())
await writeFile(OUT, JSON.stringify(encodeCatalog(catalog)))
// The committed file follows the repo's formatter, so the budget applies to that form, gzipped as served.
const fmt = Bun.spawnSync(['bunx', 'biome', 'format', '--write', OUT.pathname], { stdout: 'ignore', stderr: 'inherit' })
if (fmt.exitCode !== 0) throw new Error(`biome format exited with ${fmt.exitCode}`)
const bytes = await Bun.file(OUT).bytes()
const gzip = Bun.gzipSync(bytes).byteLength
if (gzip > BUDGET) throw new Error(`catalog.json is ${gzip} bytes gzipped, over the ${BUDGET} byte budget`)
const routes = catalog.models.reduce((n, m) => n + m.routes.length, 0)
const reachable = catalog.providers.filter(isBrowserCallable).length
console.log(
  `catalog.json: ${catalog.models.length} models, ${routes} routes, ${catalog.providers.length} providers (${reachable} browser-callable), ${bytes.byteLength} bytes, ${gzip} gzipped`,
)
