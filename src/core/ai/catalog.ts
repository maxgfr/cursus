import {
  buildCatalog,
  CATALOG_VERSION,
  type Catalog,
  type CatalogEntry,
  type CatalogModel,
  type CatalogProvider,
  type CatalogRoute,
  clientBaseUrl,
  decodeCatalog,
  fromModelsDev,
  isBrowserCallable,
  type ProviderFacts,
  parseCatalogFile,
  unknownFacts,
} from './catalogTrim'

export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** The catalog shipped with the app, in its own lazily loaded chunk. */
export async function loadBundledCatalog(): Promise<Catalog> {
  const mod = await import('./catalog.json')
  return decodeCatalog(parseCatalogFile(mod.default))
}

/** Whether a stored value is a catalog of the current shape (older stored catalogs are dropped). */
export function isCurrentCatalog(value: unknown): value is Catalog {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === CATALOG_VERSION &&
    'models' in value &&
    Array.isArray(value.models)
  )
}

/**
 * Re-fetches models.dev with a simple GET (it is CORS `*` but refuses preflights) and applies the
 * build-time reduction. CORS cannot be probed from a page, so each provider's base URL and browser
 * verdict come from `previous`; a provider new since then is `unknown`.
 */
export async function refreshCatalog(
  previous: Catalog,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Catalog> {
  const res = await fetchFn(MODELS_DEV_URL)
  if (!res.ok) throw new Error(`models.dev answered ${res.status}`)
  const at = new Date(now()).toISOString()
  const before = new Map(previous.providers.map((p) => [p.id, p]))
  return buildCatalog(
    fromModelsDev(await res.json()),
    (p): ProviderFacts => {
      const old = before.get(p.id)
      const wasBlocked = previous.blocked[p.id]
      const checkedApi = old?.api ?? wasBlocked ?? null
      const api = clientBaseUrl(p, checkedApi)
      const source = p.api && api === p.api ? 'api' : (old?.baseUrlSource ?? 'default')
      // Same address as when it was checked: the verdict still holds, blocked included.
      if (api !== null && api === checkedApi) {
        if (old) return { api, baseUrlSource: source, browser: old.browser, previousApi: old.previousApi }
        return { api, baseUrlSource: source, browser: { verdict: 'blocked', evidence: 'none', checkedAt: at } }
      }
      // A new address is a new server: nothing carries over, and the UI asks for a test before any key goes there.
      const facts = unknownFacts(at, api)
      if (checkedApi !== null) facts.previousApi = checkedApi
      facts.baseUrlSource = api === null ? 'none' : source
      return facts
    },
    at,
  )
}

export function findProvider(catalog: Catalog, providerId: string): CatalogProvider | undefined {
  return catalog.providers.find((p) => p.id === providerId)
}

export function findEntry(catalog: Catalog, entryId: string): CatalogEntry | undefined {
  return catalog.models.find((m) => m.id === entryId)
}

/** The model a route serves, found by the provider's id for it. */
export function findRoute(
  catalog: Catalog,
  providerId: string,
  providerModelId: string,
): { entry: CatalogEntry; route: CatalogRoute } | undefined {
  for (const entry of catalog.models) {
    const route = entry.routes.find((r) => r.provider === providerId && r.id === providerModelId)
    if (route) return { entry, route }
  }
  return undefined
}

/** The flat model one route serves, as the features consume it. */
export function routeModel(entry: CatalogEntry, route: CatalogRoute): CatalogModel {
  const m: CatalogModel = {
    id: route.id,
    name: entry.name,
    provider: route.provider,
    context_length: entry.context_length,
    modalities: { input: [...entry.modalities.input] },
    capabilities: { ...entry.capabilities },
  }
  if (entry.output_limit !== undefined) m.output_limit = entry.output_limit
  if (route.cost) m.cost = { ...route.cost }
  if (entry.release_date) m.release_date = entry.release_date
  return m
}

export function findModel(catalog: Catalog, providerId: string, providerModelId: string): CatalogModel | undefined {
  const hit = findRoute(catalog, providerId, providerModelId)
  return hit ? routeModel(hit.entry, hit.route) : undefined
}

/** Models a provider serves, each with its route there. */
export function modelsOf(catalog: Catalog, providerId: string): { entry: CatalogEntry; route: CatalogRoute }[] {
  const out: { entry: CatalogEntry; route: CatalogRoute }[] = []
  for (const entry of catalog.models) {
    for (const route of entry.routes) if (route.provider === providerId) out.push({ entry, route })
  }
  return out
}

const KIND_ORDER = { vendor: 0, aggregator: 1, host: 2 } as const
const total = (r: CatalogRoute) => (r.cost ? r.cost.input + r.cost.output : Number.POSITIVE_INFINITY)

/** Routes of a model: the vendor's own API first, then aggregators, then hosts; reachable and cheap first within each. */
export function orderedRoutes(catalog: Catalog, entry: CatalogEntry): CatalogRoute[] {
  const byId = new Map(catalog.providers.map((p) => [p.id, p]))
  const rank = (r: CatalogRoute) => {
    if (r.provider === entry.vendor) return -1
    const p = byId.get(r.provider)
    return p ? KIND_ORDER[p.kind] : 3
  }
  const callable = (r: CatalogRoute) => {
    const p = byId.get(r.provider)
    return p && isBrowserCallable(p) ? 0 : 1
  }
  return [...entry.routes].sort(
    (a, b) =>
      rank(a) - rank(b) || callable(a) - callable(b) || total(a) - total(b) || a.provider.localeCompare(b.provider),
  )
}

/**
 * The route a model is called through unless the user picks another: the vendor's own API when a
 * browser can reach it, else the cheapest browser-callable route. Undefined when none is reachable.
 */
export function defaultRoute(catalog: Catalog, entry: CatalogEntry): CatalogRoute | undefined {
  const callable = new Set(catalog.providers.filter(isBrowserCallable).map((p) => p.id))
  const own = entry.routes.find((r) => r.provider === entry.vendor)
  if (own && callable.has(own.provider)) return own
  return entry.routes
    .filter((r) => callable.has(r.provider))
    .sort((a, b) => total(a) - total(b) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))[0]
}

/** Providers offered first, as the user's other apps do: the big vendors' own APIs. */
export const RECOMMENDED_PROVIDERS: readonly string[] = ['anthropic', 'openai', 'google', 'mistral']

export interface CatalogHit {
  entry: CatalogEntry
  route: CatalogRoute
}

/**
 * The model a provider suggests: one of its own when it makes models, structured output first,
 * then the newest, then the cheapest. Variants such as `:batch` are never suggested.
 */
export function recommendedModel(catalog: Catalog, providerId: string): CatalogHit | undefined {
  const all = modelsOf(catalog, providerId).filter(({ route }) => !route.id.includes(':'))
  const own = all.filter(({ entry }) => entry.vendor === providerId)
  const pool = own.length > 0 ? own : all
  return [...pool].sort(
    (a, b) =>
      Number(Boolean(b.entry.capabilities.structured_output)) -
        Number(Boolean(a.entry.capabilities.structured_output)) ||
      (b.entry.release_date ?? '').localeCompare(a.entry.release_date ?? '') ||
      total(a.route) - total(b.route) ||
      a.entry.name.localeCompare(b.entry.name),
  )[0]
}

export interface SearchGroup {
  provider: CatalogProvider
  hits: CatalogHit[]
}

export interface SearchOptions {
  /** Provider shown when the query is empty. */
  providerId?: string
  structured: boolean
  /** Keeps a provider's routes; the settings screen passes "works in the browser" here. */
  reachable: (p: CatalogProvider) => boolean
}

const words = (q: string) => q.trim().toLowerCase().split(/\s+/).filter(Boolean)
const has = (hay: string, ws: readonly string[]) => ws.every((w) => hay.includes(w))

/**
 * One search over providers and models. Empty: the chosen provider's models. A query naming a
 * provider ("anthropic", "302") lists that provider's models; otherwise every route whose provider
 * and model together match, grouped by provider, the model maker's own API first.
 */
export function searchCatalog(catalog: Catalog, query: string, opts: SearchOptions): SearchGroup[] {
  const ws = words(query)
  const keep = (hit: CatalogHit) => !opts.structured || Boolean(hit.entry.capabilities.structured_output)
  const providers = catalog.providers.filter(opts.reachable)
  const groupOf = (p: CatalogProvider, hits: CatalogHit[]): SearchGroup => {
    const rec = recommendedModel(catalog, p.id)
    const first = (h: CatalogHit) => (rec && h.route.id === rec.route.id ? 0 : 1)
    return {
      provider: p,
      hits: hits.filter(keep).sort((a, b) => first(a) - first(b) || a.entry.name.localeCompare(b.entry.name)),
    }
  }
  if (ws.length === 0) {
    const p = providers.find((x) => x.id === opts.providerId)
    return p ? [groupOf(p, modelsOf(catalog, p.id))].filter((g) => g.hits.length > 0) : []
  }
  const named = providers.filter((p) => has(`${p.name} ${p.id}`.toLowerCase(), ws))
  if (named.length > 0) {
    return named
      .map((p) => groupOf(p, modelsOf(catalog, p.id)))
      .filter((g) => g.hits.length > 0)
      .sort((a, b) => a.provider.name.localeCompare(b.provider.name))
  }
  const byProvider = new Map(providers.map((p) => [p.id, p]))
  const found = new Map<string, { p: CatalogProvider; hits: CatalogHit[] }>()
  const ownApi = new Set<string>()
  for (const entry of catalog.models) {
    for (const route of entry.routes) {
      const p = byProvider.get(route.provider)
      if (!p) continue
      const hay = `${p.name} ${p.id} ${entry.name} ${entry.id} ${route.id}`.toLowerCase()
      if (!has(hay, ws)) continue
      const group = found.get(p.id) ?? { p, hits: [] }
      group.hits.push({ entry, route })
      found.set(p.id, group)
      if (entry.vendor === p.id) ownApi.add(p.id)
    }
  }
  const recRank = (id: string) => {
    const i = RECOMMENDED_PROVIDERS.indexOf(id)
    return i < 0 ? RECOMMENDED_PROVIDERS.length : i
  }
  return [...found.values()]
    .map(({ p, hits }) => groupOf(p, hits))
    .filter((g) => g.hits.length > 0)
    .sort(
      (a, b) =>
        Number(ownApi.has(b.provider.id)) - Number(ownApi.has(a.provider.id)) ||
        recRank(a.provider.id) - recRank(b.provider.id) ||
        KIND_ORDER[a.provider.kind] - KIND_ORDER[b.provider.kind] ||
        a.provider.name.localeCompare(b.provider.name),
    )
}
