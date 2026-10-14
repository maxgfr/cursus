import bundled from './catalog.json'
import {
  type Catalog,
  type CatalogModel,
  type CatalogProvider,
  fromModelsDev,
  keepProvider,
  trimProvider,
} from './catalogTrim'

export const MODELS_DEV_URL = 'https://models.dev/api.json'

export function bundledCatalog(): Catalog {
  return bundled as Catalog
}

/**
 * Re-fetches models.dev with a simple GET (it is CORS `*` but refuses preflights) and applies the
 * build-time reduction. CORS cannot be probed from a page, so `browserCallable` comes from `previous`.
 */
export async function refreshCatalog(
  previous: Catalog = bundledCatalog(),
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Catalog> {
  const res = await fetchFn(MODELS_DEV_URL)
  if (!res.ok) throw new Error(`models.dev answered ${res.status}`)
  const callable = new Map(previous.providers.map((p) => [p.id, p.browserCallable]))
  const providers = fromModelsDev(await res.json())
    .filter(keepProvider)
    .map((p) => {
      const ok = callable.get(p.id) ?? false
      const t = trimProvider(p, ok)
      return ok ? t : { ...t, models: [] }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  return { generatedAt: new Date(now()).toISOString(), providers }
}

export function findProvider(catalog: Catalog, providerId: string): CatalogProvider | undefined {
  return catalog.providers.find((p) => p.id === providerId)
}

export function findModel(catalog: Catalog, providerId: string, modelId: string): CatalogModel | undefined {
  return findProvider(catalog, providerId)?.models.find((m) => m.id === modelId)
}

/** Models a page can call directly, i.e. from browser-callable providers. */
export function callableModels(catalog: Catalog): CatalogModel[] {
  return catalog.providers.filter((p) => p.browserCallable).flatMap((p) => p.models)
}
