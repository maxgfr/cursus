import { findModel, findProvider, isCurrentCatalog, loadBundledCatalog } from '../../../core/ai/catalog'
import type { Catalog, CatalogModel, CatalogProvider } from '../../../core/ai/catalogTrim'
import { type AiConfig, CUSTOM_PROVIDER, migrateConfig } from '../../../core/ai/config'
import { type DeviceChecks, routeStatus } from '../../../core/ai/deviceCheck'
import { LOCAL_PROVIDER, LOCAL_PROVIDER_INFO } from '../../../core/ai/local'
import type { Secrets } from '../../../core/storage/secrets'

/**
 * The AI settings stored on this device and whether they name a model ready to call. Nothing here loads the AI
 * SDK: the shell reads it to decide whether AI shows at all.
 */

export const CONFIG = 'ai-config'
export const CATALOG = 'ai-catalog'
export const CHECKS = 'ai-device-checks'
export const keyName = (providerId: string) => `ai-key-${providerId}`

/** The on-device model the config names, as the features see it, and whether its files are all here. */
export interface LocalRoute {
  info: CatalogModel
  downloaded: boolean
}

export interface AiSettings {
  config: AiConfig
  catalog: Catalog
  /** Key of the selected provider, if any. */
  apiKey: string
  checks: DeviceChecks
  /** Set when the config names a model that runs on this device (no catalog lists those). */
  local?: LocalRoute
}

/**
 * The on-device model `modelId`, looked up in llm-models' browser catalog. That module and the
 * service load only here, when the config names an on-device model: never for a cloud route.
 */
async function loadLocalRoute(modelId: string): Promise<LocalRoute | undefined> {
  const { localModels } = await import('../../../core/ai/localModels')
  const service = localModels()
  const model = service.find(modelId)
  const info = service.info(modelId)
  if (!model || !info) return undefined
  return { info, downloaded: await service.handle(model).isDownloaded() }
}

export async function loadAiSettings(vault: Secrets): Promise<AiSettings> {
  const stored = await vault.get<unknown>(CATALOG)
  // A catalog stored by an older version has another shape: fall back to the bundled one.
  const catalog = isCurrentCatalog(stored) ? stored : await loadBundledCatalog()
  const config = migrateConfig(await vault.get<unknown>(CONFIG), catalog)
  const checks = (await vault.get<DeviceChecks>(CHECKS)) ?? {}
  if (config.providerId === LOCAL_PROVIDER) {
    // Keyless: nothing to read from the vault but the config.
    const local = config.modelId ? await loadLocalRoute(config.modelId) : undefined
    return local ? { config, catalog, apiKey: '', checks, local } : { config, catalog, apiKey: '', checks }
  }
  const apiKey = config.providerId ? ((await vault.get<string>(keyName(config.providerId))) ?? '') : ''
  return { config, catalog, apiKey, checks }
}

/** The user's own endpoint, called the OpenAI-compatible way. Nothing about it is known in advance. */
export function customProvider(name: string, baseUrl: string): CatalogProvider {
  return {
    id: CUSTOM_PROVIDER,
    name,
    npm: '@ai-sdk/openai-compatible',
    api: baseUrl.trim() || null,
    baseUrlSource: 'none',
    kind: 'host',
    browser: { verdict: 'unknown', evidence: 'none', checkedAt: new Date(0).toISOString() },
  }
}

/**
 * The provider as the client should call it, with the user's base URL applied. Another URL is
 * another server, so the build's browser verdict no longer applies to it.
 */
export function effectiveProvider(provider: CatalogProvider, baseUrl: string | undefined): CatalogProvider {
  const url = baseUrl?.trim()
  if (!url || url === provider.api) return provider
  return {
    ...provider,
    api: url,
    browser: { verdict: 'unknown', evidence: 'none', checkedAt: provider.browser.checkedAt },
  }
}

/**
 * The configured route resolved against the catalog, the custom endpoint, or the on-device model
 * (`localInfo` looks those up: no catalog lists them).
 */
export function resolveRoute(
  config: AiConfig,
  catalog: Catalog,
  customName: string,
  localInfo: (modelId: string) => CatalogModel | undefined = () => undefined,
): { provider: CatalogProvider; info: CatalogModel } | undefined {
  const { providerId, modelId } = config
  if (!providerId || !modelId) return undefined
  if (providerId === LOCAL_PROVIDER) {
    const info = localInfo(modelId)
    return info ? { provider: LOCAL_PROVIDER_INFO, info } : undefined
  }
  if (providerId === CUSTOM_PROVIDER) {
    const provider = customProvider(customName, config.baseUrl ?? '')
    if (!provider.api) return undefined
    return {
      provider,
      info: {
        id: modelId,
        name: modelId,
        provider: CUSTOM_PROVIDER,
        context_length: 8192,
        modalities: { input: ['text'] },
        capabilities: {},
      },
    }
  }
  const provider = findProvider(catalog, providerId)
  const info = findModel(catalog, providerId, modelId)
  if (!provider || !info) return undefined
  return { provider: effectiveProvider(provider, config.baseUrl), info }
}

/** The route the settings name, the on-device model included. */
export function routeOf(settings: AiSettings): { provider: CatalogProvider; info: CatalogModel } | undefined {
  const local = settings.local
  return resolveRoute(settings.config, settings.catalog, CUSTOM_PROVIDER, (id) =>
    local?.info.id === id ? local.info : undefined,
  )
}

/** Why no model can be called: nothing chosen, no key, the on-device model not downloaded, or the provider moved. */
export type MissingReason = 'none' | 'noKey' | 'notDownloaded' | 'moved'

export type SettingsStatus =
  | { status: 'missing'; reason: MissingReason }
  | {
      status: 'ready'
      route: { provider: CatalogProvider; info: CatalogModel }
      /** The model runs in this browser: it needs no connection (nor a key). */
      runsOffline: boolean
    }

/** Whether `settings` name a model ready to call, and its route when they do. */
export function statusOf(settings: AiSettings, route = routeOf(settings), now: number = Date.now()): SettingsStatus {
  if (!route) return { status: 'missing', reason: 'none' }
  if (route.provider.id === LOCAL_PROVIDER) {
    if (!settings.local?.downloaded) return { status: 'missing', reason: 'notDownloaded' }
    return { status: 'ready', route, runsOffline: true }
  }
  // A route this device saw blocked stays on: the settings show it and offer a new test. A
  // provider that moved to an unchecked address gets no key until the user tests it there.
  if (routeStatus(route.provider, settings.checks, now).kind === 'moved') return { status: 'missing', reason: 'moved' }
  // A local server may need no key; every catalog provider does.
  if (settings.apiKey === '' && route.provider.id !== CUSTOM_PROVIDER) return { status: 'missing', reason: 'noKey' }
  return { status: 'ready', route, runsOffline: false }
}
