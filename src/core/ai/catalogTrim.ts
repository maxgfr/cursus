import { z } from 'zod'

/** Packages the client knows how to load (see client.ts). */
export const SUPPORTED_NPM: ReadonlySet<string> = new Set([
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/openai-compatible',
  '@openrouter/ai-sdk-provider',
])

/** Bumped whenever the stored catalog shape changes; an older stored catalog is ignored. */
export const CATALOG_VERSION = 3

export interface CatalogCost {
  input: number
  output: number
}
export interface CatalogCapabilities {
  reasoning?: boolean
  tool_call?: boolean
  structured_output?: boolean
  attachment?: boolean
}

/** Where a provider's base URL comes from: its models.dev `api`, llm-models' defaults, or nowhere. */
export type BaseUrlSource = 'api' | 'default' | 'none'

/** `vendor` makes its own models, `aggregator` resells several vendors' models, `host` serves a few. */
export type ProviderKind = 'vendor' | 'aggregator' | 'host'

/**
 * Whether a page can call the provider, as checked from the build machine (llm-models' probe):
 * `callable`, `callable_with_header` (only with the headers in `headers`, e.g. Anthropic's),
 * `blocked` (CORS refuses a page) or `unknown` (no base URL, or the probe could not reach it).
 */
export type BrowserVerdict = 'callable' | 'callable_with_header' | 'blocked' | 'unknown'

/** Known caveats of a callable API: `unreadable_errors` = error answers carry no CORS headers. */
export type BrowserLimit = 'unreadable_errors'

export interface BrowserCheck {
  verdict: BrowserVerdict
  /** What the verdict rests on: the preflight, a plain GET, or nothing. */
  evidence: 'preflight' | 'get' | 'none'
  checkedAt: string
  /** Headers the page must send for the provider to answer it. */
  headers?: Record<string, string>
  limits?: BrowserLimit
}

export interface CatalogProvider {
  id: string
  name: string
  npm?: string
  /** Base URL the client calls, null when none is known. */
  api: string | null
  baseUrlSource: BaseUrlSource
  kind: ProviderKind
  browser: BrowserCheck
  /** Set when the base URL changed since the last check: nothing about the new address is known. */
  previousApi?: string
}

/** Structural subset of llm-models' `BrowserSupport`. */
export interface BrowserSupportLike {
  callable: boolean
  required_headers?: Record<string, string>
  evidence: 'preflight' | 'get' | 'none'
  checked_at: string
}

/** APIs whose error responses lack CORS headers, so a page sees a network error instead of the reason. */
const BROWSER_LIMITS: Readonly<Record<string, BrowserLimit>> = { cerebras: 'unreadable_errors' }

/** Maps llm-models' probe result to the catalog's verdict. */
export function browserVerdict(providerId: string, s: BrowserSupportLike): BrowserCheck {
  const headers = s.required_headers && Object.keys(s.required_headers).length > 0 ? s.required_headers : undefined
  const verdict: BrowserVerdict = s.callable
    ? headers
      ? 'callable_with_header'
      : 'callable'
    : s.evidence === 'none'
      ? 'unknown'
      : 'blocked'
  const out: BrowserCheck = { verdict, evidence: s.evidence, checkedAt: s.checked_at }
  if (headers && s.callable) out.headers = { ...headers }
  const limit = BROWSER_LIMITS[providerId]
  if (limit && s.callable) out.limits = limit
  return out
}

/** Whether the catalog expects a page to reach the provider. */
export function isBrowserCallable(p: { browser: BrowserCheck }): boolean {
  return p.browser.verdict === 'callable' || p.browser.verdict === 'callable_with_header'
}

/** What the build knows about a provider: where to call it and whether a page may. */
export interface ProviderFacts {
  api: string | null
  baseUrlSource: BaseUrlSource
  browser: BrowserCheck
  /** The base URL the verdict was made for, when models.dev has since moved the provider elsewhere. */
  previousApi?: string
}

/** One way to call a model: through which provider, under which id, at which price. */
export interface CatalogRoute {
  provider: string
  /** The id the provider's API expects. */
  id: string
  cost?: CatalogCost
}

/** A model once, whoever serves it. */
export interface CatalogEntry {
  /** Canonical id, `vendor/key`. */
  id: string
  name: string
  vendor: string
  family?: string
  context_length: number
  output_limit?: number
  modalities: { input: string[] }
  capabilities: CatalogCapabilities
  release_date?: string
  routes: CatalogRoute[]
}

export interface Catalog {
  version: typeof CATALOG_VERSION
  generatedAt: string
  /** Display names of vendors, by id. */
  vendors: Record<string, string>
  providers: CatalogProvider[]
  models: CatalogEntry[]
  /**
   * Providers left out because the probe found them blocked, with the base URL it checked. A refresh
   * keeps them out while that URL is unchanged.
   */
  blocked: Record<string, string>
}

/** A model as one route serves it: what the features call and price. */
export interface CatalogModel {
  /** The provider's id for the model. */
  id: string
  name: string
  provider: string
  context_length: number
  output_limit?: number
  cost?: CatalogCost
  modalities: { input: string[] }
  capabilities: CatalogCapabilities
  release_date?: string
}

/** Structural shape shared by llm-models' ProviderInfo and the normalized models.dev payload. */
export interface ModelLike {
  id: string
  name: string
  provider: string
  context_length: number
  output_limit?: number
  cost?: { input: number; output: number }
  modalities: { input: string[] }
  capabilities: CatalogCapabilities
  release_date?: string
  status?: string
  family?: string
  /** The id the provider's own API accepts (llm-models' `api_id`); absent there when the provider does not serve it. */
  api_id?: string
}
export interface ProviderLike {
  id: string
  name: string
  npm?: string
  api?: string
  models: ModelLike[]
}

/** Providers the client can call: a package it loads, or a known OpenAI-compatible base URL. */
/**
 * Packages whose API speaks OpenAI's chat completions at the provider's base URL, so the client can
 * call it with @ai-sdk/openai-compatible.
 */
const OPENAI_COMPATIBLE_NPM: ReadonlySet<string> = new Set([
  '@ai-sdk/mistral',
  '@ai-sdk/groq',
  '@ai-sdk/xai',
  '@ai-sdk/cerebras',
  '@ai-sdk/deepinfra',
  '@ai-sdk/togetherai',
  '@ai-sdk/perplexity',
])

/** Providers whose native API is not OpenAI-compatible but which publish an OpenAI-compatible one. */
const OPENAI_COMPATIBLE_BASE: Readonly<Record<string, string>> = {
  // https://docs.cohere.com/docs/compatibility-api
  cohere: 'https://api.cohere.ai/compatibility/v1',
}

/**
 * The package the client calls a provider with, or null when we do not speak its wire protocol
 * (Bedrock, Azure, Vertex, custom SDKs, providers without a package).
 */
export function clientPackage(p: { id: string; npm?: string | null }): string | null {
  if (OPENAI_COMPATIBLE_BASE[p.id]) return '@ai-sdk/openai-compatible'
  if (p.npm && SUPPORTED_NPM.has(p.npm)) return p.npm
  if (p.npm && OPENAI_COMPATIBLE_NPM.has(p.npm)) return '@ai-sdk/openai-compatible'
  return null
}

/** The base URL the client calls: an OpenAI-compatible override first, then models.dev's `api`. */
export function clientBaseUrl(p: { id: string; api?: string | null }, fallback: string | null): string | null {
  return OPENAI_COMPATIBLE_BASE[p.id] ?? p.api ?? fallback
}

/** https for any host; plain http only for this machine (the page's CSP and mixed content block the rest). */
export type EndpointCheck = 'ok' | 'insecure' | 'invalid'
export function checkEndpoint(url: string): EndpointCheck {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return 'invalid'
  }
  if (u.protocol === 'https:') return 'ok'
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return 'ok'
  return u.protocol === 'http:' ? 'insecure' : 'invalid'
}

/** Providers the client can call: a protocol it speaks, at an https base URL. */
export function keepProvider(p: { id: string; npm?: string | null }, api: string | null): boolean {
  return clientPackage(p) !== null && api?.startsWith('https://') === true
}

/** Vendor ids as aggregators spell them, mapped to the provider id of the vendor's own API. */
const VENDOR_ALIASES: Readonly<Record<string, string>> = {
  'meta-llama': 'meta',
  mistralai: 'mistral',
  'x-ai': 'xai',
  'z-ai': 'zai',
  qwen: 'alibaba',
  moonshotai: 'moonshotai',
  'deepseek-ai': 'deepseek',
}

/** Model-name prefixes whose maker is known, for ids that carry no vendor prefix (e.g. 302.AI's). */
const FAMILY_VENDORS: readonly (readonly [RegExp, string])[] = [
  [/^claude/, 'anthropic'],
  [/^(gpt|o\d|chatgpt|codex)(-|$)/, 'openai'],
  [/^(gemini|gemma)/, 'google'],
  [/^(mistral|ministral|codestral|magistral|devstral|pixtral|voxtral)/, 'mistral'],
  [/^grok/, 'xai'],
  [/^(llama|meta-llama)/, 'meta'],
  [/^deepseek/, 'deepseek'],
  [/^(qwen|qwq)/, 'alibaba'],
  [/^glm/, 'zai'],
  [/^kimi/, 'moonshotai'],
]

/** Names for vendors that have no provider entry of their own. */
const VENDOR_NAMES: Readonly<Record<string, string>> = {
  meta: 'Meta',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  mistral: 'Mistral',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  alibaba: 'Alibaba',
  zai: 'Z.ai',
  moonshotai: 'Moonshot AI',
}

/** The id the provider's API wants: its `api_id`, else the id without the provider's own prefix. */
function bareId(m: ModelLike): string {
  if (m.api_id !== undefined) return m.api_id
  const prefix = `${m.provider}/`
  return m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id
}

/** Identity of a model across providers: the last path segment, case and `.`/`_` folded. */
export function modelKey(providerModelId: string): string {
  return providerModelId
    .slice(providerModelId.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/[._]/g, '-')
}

/** The vendor segment an aggregator puts before the model (`anthropic/claude-…` → `anthropic`). */
function prefixVendor(providerModelId: string): string | null {
  const parts = providerModelId.split('/')
  if (parts.length < 2) return null
  const raw = (parts[parts.length - 2] ?? '').replace(/^[~@]/, '').toLowerCase()
  if (raw === '' || raw === 'cf' || raw === 'models') return null
  return VENDOR_ALIASES[raw] ?? raw
}

function familyVendor(key: string): string | null {
  for (const [re, vendor] of FAMILY_VENDORS) if (re.test(key)) return vendor
  return null
}

/** Drops the `Vendor: ` prefix aggregators add to display names. */
function cleanName(name: string): string {
  const i = name.indexOf(': ')
  return i > 0 && i <= 30 ? name.slice(i + 2) : name
}

function trimCaps(c: CatalogCapabilities): CatalogCapabilities {
  const caps: CatalogCapabilities = {}
  if (c.reasoning) caps.reasoning = true
  if (c.tool_call) caps.tool_call = true
  if (c.structured_output) caps.structured_output = true
  if (c.attachment) caps.attachment = true
  return caps
}

function routeOf(m: ModelLike): CatalogRoute {
  const r: CatalogRoute = { provider: m.provider, id: bareId(m) }
  if (m.cost) r.cost = { input: m.cost.input, output: m.cost.output }
  return r
}

function usable(m: ModelLike): boolean {
  return m.status !== 'deprecated' && m.modalities.input.includes('text')
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Reduces providers to a deduplicated model list, each model with every route that serves it.
 * No model of a kept provider is dropped (blocked providers are left out); `facts` gives each provider's base URL and browser verdict.
 */
export function buildCatalog(
  input: readonly ProviderLike[],
  facts: (p: ProviderLike) => ProviderFacts,
  generatedAt: string,
): Catalog {
  const known = new Map(input.map((p) => [p.id, facts(p)]))
  // A provider the probe found blocked cannot serve a page; listing its models would only add dead routes.
  const blocked: Record<string, string> = {}
  const kept = input.filter((p) => {
    const f = known.get(p.id)
    if (!f || !keepProvider(p, f.api)) return false
    if (f.browser.verdict !== 'blocked') return true
    if (f.api) blocked[p.id] = f.api
    return false
  })
  const providerIds = new Set(kept.map((p) => p.id))
  const groups = new Map<string, ModelLike[]>()
  // Listings left out still describe the model: a maker's own, for one it no longer serves, beats a reseller's.
  const unused = new Map<string, ModelLike[]>()
  for (const p of kept) {
    for (const m of p.models) {
      const key = modelKey(bareId(m))
      if (!usable(m)) {
        unused.set(key, [...(unused.get(key) ?? []), m])
        continue
      }
      const list = groups.get(key)
      if (list) list.push(m)
      else groups.set(key, [m])
    }
  }

  const vendorsOf = new Map<string, Set<string>>()
  const models: CatalogEntry[] = []
  for (const [key, members] of groups) {
    const votes = new Map<string, number>()
    for (const m of members) {
      const v = prefixVendor(bareId(m))
      if (v) votes.set(v, (votes.get(v) ?? 0) + 1)
    }
    const voted = [...votes].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0]?.[0]
    const sortedProviders = [...new Set(members.map((m) => m.provider))].sort(compare)
    const vendor =
      familyVendor(key) ??
      voted ??
      (sortedProviders.length === 1 ? sortedProviders[0] : undefined) ??
      sortedProviders.find((id) => providerIds.has(id)) ??
      'other'
    // The vendor's own listing describes the model best; otherwise the most complete one.
    const primary =
      members.find((m) => m.provider === vendor && !cleanName(m.name).includes(':')) ??
      [...members].sort(
        (a, b) =>
          Number(Boolean(b.release_date)) - Number(Boolean(a.release_date)) ||
          compare(a.provider, b.provider) ||
          compare(a.id, b.id),
      )[0]
    if (!primary) continue
    // Aggregators often leave capability flags out (`reasoning` on Gemini 2.5): the maker's own flags win.
    const ofVendor = (m: ModelLike) => m.provider === vendor
    const maker = members.find(ofVendor) ?? unused.get(key)?.find(ofVendor)
    const seen = new Set<string>()
    const routes: CatalogRoute[] = []
    for (const m of members) {
      const r = routeOf(m)
      const id = `${r.provider}\u0000${r.id}`
      if (seen.has(id)) continue
      seen.add(id)
      routes.push(r)
      const vs = vendorsOf.get(r.provider) ?? new Set<string>()
      vs.add(vendor)
      vendorsOf.set(r.provider, vs)
    }
    routes.sort((a, b) => compare(a.provider, b.provider) || compare(a.id, b.id))
    const entry: CatalogEntry = {
      id: `${vendor}/${key}`,
      name: cleanName(primary.name),
      vendor,
      context_length: primary.context_length,
      modalities: { input: [...primary.modalities.input] },
      capabilities: trimCaps(maker?.capabilities ?? primary.capabilities),
      routes,
    }
    if (primary.family) entry.family = primary.family
    if (primary.output_limit !== undefined) entry.output_limit = primary.output_limit
    if (primary.release_date) entry.release_date = primary.release_date
    models.push(entry)
  }
  models.sort((a, b) => compare(a.vendor, b.vendor) || compare(a.name, b.name) || compare(a.id, b.id))

  const vendorIds = new Set(models.map((m) => m.vendor))
  const providers: CatalogProvider[] = kept
    .map((p): CatalogProvider => {
      const served = vendorsOf.get(p.id) ?? new Set<string>()
      // Reselling three or more makers' models makes an aggregator, even when it also lists its own.
      const others = [...served].filter((v) => v !== p.id).length
      const kind: ProviderKind = others >= 3 ? 'aggregator' : served.has(p.id) ? 'vendor' : 'host'
      const f = known.get(p.id) ?? unknownFacts(generatedAt)
      const out: CatalogProvider = {
        id: p.id,
        name: p.name,
        api: f.api,
        baseUrlSource: f.baseUrlSource,
        kind,
        browser: f.browser,
      }
      const npm = clientPackage(p)
      if (npm) out.npm = npm
      if (f.previousApi) out.previousApi = f.previousApi
      return out
    })
    .sort((a, b) => compare(a.id, b.id))

  const vendors: Record<string, string> = {}
  const names = new Map(providers.map((p) => [p.id, p.name]))
  for (const v of [...vendorIds].sort(compare)) {
    vendors[v] = VENDOR_NAMES[v] ?? names.get(v) ?? v.charAt(0).toUpperCase() + v.slice(1)
  }
  return { version: CATALOG_VERSION, generatedAt, vendors, providers, models, blocked: sortedRecord(blocked) }
}

function sortedRecord(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).sort((a, b) => compare(a[0], b[0])))
}

/** Facts for a provider nobody checked. */
export function unknownFacts(checkedAt: string, api: string | null = null): ProviderFacts {
  return {
    api,
    baseUrlSource: api ? 'api' : 'none',
    browser: { verdict: 'unknown', evidence: 'none', checkedAt },
  }
}

/** A route as stored in catalog.json: `[provider, id]` or `[provider, id, input $/M, output $/M]`. */
export type RouteTuple = [string, string] | [string, string, number, number]
export type CatalogEntryFile = Omit<CatalogEntry, 'routes'> & { routes: RouteTuple[] }
/** catalog.json's shape: routes as tuples keep the file within the formatter's 1 MiB limit. */
export type CatalogFile = Omit<Catalog, 'models'> & { models: CatalogEntryFile[] }

export function encodeCatalog(c: Catalog): CatalogFile {
  return {
    ...c,
    models: c.models.map((m) => ({
      ...m,
      routes: m.routes.map(
        (r): RouteTuple => (r.cost ? [r.provider, r.id, r.cost.input, r.cost.output] : [r.provider, r.id]),
      ),
    })),
  }
}

export function decodeCatalog(f: CatalogFile): Catalog {
  return {
    ...f,
    models: f.models.map((m) => ({
      ...m,
      routes: m.routes.map((t): CatalogRoute => {
        const r: CatalogRoute = { provider: t[0], id: t[1] }
        if (t.length === 4) r.cost = { input: t[2], output: t[3] }
        return r
      }),
    })),
  }
}

const cost = z.number()
const browserCheck = z.object({
  verdict: z.enum(['callable', 'callable_with_header', 'blocked', 'unknown']),
  evidence: z.enum(['preflight', 'get', 'none']),
  checkedAt: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  limits: z.literal('unreadable_errors').optional(),
})
const catalogFile = z.object({
  version: z.literal(CATALOG_VERSION),
  generatedAt: z.string(),
  vendors: z.record(z.string(), z.string()),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      npm: z.string().optional(),
      api: z.string().nullable(),
      baseUrlSource: z.enum(['api', 'default', 'none']),
      kind: z.enum(['vendor', 'aggregator', 'host']),
      browser: browserCheck,
      previousApi: z.string().optional(),
    }),
  ),
  blocked: z.record(z.string(), z.string()),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      vendor: z.string(),
      family: z.string().optional(),
      context_length: z.number(),
      output_limit: z.number().optional(),
      modalities: z.object({ input: z.array(z.string()) }),
      capabilities: z.object({
        reasoning: z.boolean().optional(),
        tool_call: z.boolean().optional(),
        structured_output: z.boolean().optional(),
        attachment: z.boolean().optional(),
      }),
      release_date: z.string().optional(),
      routes: z.array(z.union([z.tuple([z.string(), z.string()]), z.tuple([z.string(), z.string(), cost, cost])])),
    }),
  ),
})

/** Validates catalog.json's content; a malformed file throws. */
export function parseCatalogFile(raw: unknown): CatalogFile {
  return catalogFile.parse(raw)
}

const devModel = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  release_date: z.string().optional(),
  status: z.string().optional(),
  reasoning: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  attachment: z.boolean().optional(),
  modalities: z.object({ input: z.array(z.string()) }).optional(),
  cost: z.object({ input: z.number(), output: z.number() }).optional(),
  limit: z.object({ context: z.number(), output: z.number().optional() }),
})
const devProvider = z.object({
  id: z.string(),
  name: z.string(),
  npm: z.string().optional(),
  api: z.string().optional(),
  models: z.record(z.string(), z.unknown()),
})

/**
 * llm-models' providers with only the models each one's own API serves: a vendor's list also holds what OpenRouter
 * alone serves under the vendor's name (`claude-opus-4.1`, `…:batch`), which the vendor's API rejects.
 */
export function fromLlmModels(input: readonly ProviderLike[]): ProviderLike[] {
  return input.map((p) => ({ ...p, models: p.models.filter((m) => m.api_id !== undefined) }))
}

/** Normalizes the raw models.dev `api.json` payload. Malformed models are skipped, a malformed root throws. */
export function fromModelsDev(raw: unknown): ProviderLike[] {
  const root = z.record(z.string(), z.unknown()).parse(raw)
  const out: ProviderLike[] = []
  for (const value of Object.values(root)) {
    const p = devProvider.safeParse(value)
    if (!p.success) continue
    const models: ModelLike[] = []
    for (const mv of Object.values(p.data.models)) {
      const m = devModel.safeParse(mv)
      if (!m.success) continue
      const d = m.data
      models.push({
        id: d.id,
        // models.dev keys a model by the id its provider's API accepts, prefix included (`openrouter/auto`).
        api_id: d.id,
        name: d.name,
        provider: p.data.id,
        family: d.family,
        context_length: d.limit.context,
        output_limit: d.limit.output,
        cost: d.cost,
        modalities: { input: d.modalities?.input ?? ['text'] },
        capabilities: {
          reasoning: d.reasoning,
          tool_call: d.tool_call,
          structured_output: d.structured_output,
          attachment: d.attachment,
        },
        release_date: d.release_date,
        status: d.status,
      })
    }
    out.push({ id: p.data.id, name: p.data.name, npm: p.data.npm, api: p.data.api, models })
  }
  return out
}
