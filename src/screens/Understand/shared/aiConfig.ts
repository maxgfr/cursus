import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRuntime, useWorkspace } from '../../../app/workspaceContext.tsx'
import { findModel, findProvider, isCurrentCatalog, loadBundledCatalog } from '../../../core/ai/catalog'
import { type Catalog, type CatalogModel, type CatalogProvider, isBrowserCallable } from '../../../core/ai/catalogTrim'
import { createModel, type FeatureCtx, outputLanguage } from '../../../core/ai/client'
import { type AiConfig, CUSTOM_PROVIDER, migrateConfig } from '../../../core/ai/config'
import { costOf } from '../../../core/ai/cost'
import { checkKey, type DeviceCheck, type DeviceChecks, routeStatus } from '../../../core/ai/deviceCheck'
import type { AiUsageEvent } from '../../../core/ai/usage'
import type { ModelWorkspace } from '../../../core/model/workspace'
import { type Secrets, secretsVault } from '../../../core/storage/secrets'
import { useLocale } from '../../../i18n/react.tsx'

export { type AiConfig, type AiLanguage, CUSTOM_PROVIDER, DEFAULT_CONFIG, migrateConfig } from '../../../core/ai/config'
export {
  checkKey,
  type DeviceCheck,
  type DeviceChecks,
  type RouteStatus,
  routeStatus,
} from '../../../core/ai/deviceCheck'

const CONFIG = 'ai-config'
const CATALOG = 'ai-catalog'
const CHECKS = 'ai-device-checks'
const keyName = (providerId: string) => `ai-key-${providerId}`

export function useVault(): Secrets {
  const rt = useRuntime()
  return useMemo(() => secretsVault(rt.store), [rt])
}

export interface AiSettings {
  config: AiConfig
  catalog: Catalog
  /** Key of the selected provider, if any. */
  apiKey: string
  checks: DeviceChecks
}

export async function loadAiSettings(vault: Secrets): Promise<AiSettings> {
  const stored = await vault.get<unknown>(CATALOG)
  // A catalog stored by an older version has another shape: fall back to the bundled one.
  const catalog = isCurrentCatalog(stored) ? stored : await loadBundledCatalog()
  const config = migrateConfig(await vault.get<unknown>(CONFIG), catalog)
  const apiKey = config.providerId ? ((await vault.get<string>(keyName(config.providerId))) ?? '') : ''
  const checks = (await vault.get<DeviceChecks>(CHECKS)) ?? {}
  return { config, catalog, apiKey, checks }
}

export const saveConfig = (vault: Secrets, config: AiConfig) => vault.set(CONFIG, config)
export const saveCatalog = (vault: Secrets, catalog: Catalog) => vault.set(CATALOG, catalog)
export async function saveKey(vault: Secrets, providerId: string, key: string): Promise<void> {
  if (key.trim() === '') await vault.delete(keyName(providerId))
  else await vault.set(keyName(providerId), key.trim())
}
export const loadKey = async (vault: Secrets, providerId: string) =>
  (await vault.get<string>(keyName(providerId))) ?? ''

export async function saveCheck(vault: Secrets, provider: CatalogProvider, check: DeviceCheck): Promise<DeviceChecks> {
  const checks = { ...((await vault.get<DeviceChecks>(CHECKS)) ?? {}), [checkKey(provider)]: check }
  await vault.set(CHECKS, checks)
  return checks
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

/** The configured route resolved against the catalog, or the custom endpoint. */
export function resolveRoute(
  config: AiConfig,
  catalog: Catalog,
  customName: string,
): { provider: CatalogProvider; info: CatalogModel } | undefined {
  const { providerId, modelId } = config
  if (!providerId || !modelId) return undefined
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

export function languageName(config: AiConfig, courseLanguage: string | undefined, uiLocale: string): string {
  if (config.language !== 'auto') return outputLanguage(undefined, config.language)
  return outputLanguage(courseLanguage, uiLocale)
}

/** Records a usage event in the workspace as `provider/model` so its cost can be priced later. */
export function recordUsage(ws: ModelWorkspace, e: AiUsageEvent): void {
  ws.aiUsage.record({ model: `${e.provider}/${e.model}`, inTok: e.inputTokens, outTok: e.outputTokens })
}

/** Cost of this month's usage, priced with the current catalog. */
export function monthCostOf(ws: ModelWorkspace, catalog: Catalog, now: number): number {
  const d = new Date(now)
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  let total = 0
  for (const e of ws.aiUsage.list()) {
    if (e.at < start || e.at >= end) continue
    const slash = e.model.indexOf('/')
    const info = slash > 0 ? findModel(catalog, e.model.slice(0, slash), e.model.slice(slash + 1)) : undefined
    total += costOf({ inputTokens: e.inTok, outputTokens: e.outTok }, info?.cost)
  }
  return total
}

export type AiModelState =
  | { status: 'loading' }
  | { status: 'missing' }
  | {
      status: 'ready'
      info: CatalogModel
      provider: CatalogProvider
      /** Builds a feature context; `courseLanguage` picks the output language when set to auto. */
      context(signal: AbortSignal, courseLanguage?: string): Promise<FeatureCtx>
    }

/** The selected model, ready to call, or `missing` when no model or key is set up. */
export function useAiModel(): AiModelState {
  const vault = useVault()
  const ws = useWorkspace()
  const locale = useLocale()
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    loadAiSettings(vault).then(
      (s) => {
        if (live) setSettings(s)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [vault])

  const route = useMemo(
    () => (settings ? resolveRoute(settings.config, settings.catalog, CUSTOM_PROVIDER) : undefined),
    [settings],
  )

  const context = useCallback(
    async (signal: AbortSignal, courseLanguage?: string): Promise<FeatureCtx> => {
      if (!settings) throw new Error('AI settings are not loaded')
      if (!route) throw new Error('No model selected')
      const model = await createModel({ provider: route.provider, modelId: route.info.id, apiKey: settings.apiKey })
      return {
        model,
        info: route.info,
        language: languageName(settings.config, courseLanguage, locale === 'pseudo' ? 'en' : locale),
        signal,
        onUsage: (e) => recordUsage(ws, e),
      }
    },
    [settings, route, ws, locale],
  )

  return useMemo((): AiModelState => {
    if (failed) return { status: 'missing' }
    if (!settings) return { status: 'loading' }
    if (!route) return { status: 'missing' }
    // A route this device saw blocked stays on: the settings show it and offer a new test. A
    // provider that moved to an unchecked address gets no key until the user tests it there.
    if (routeStatus(route.provider, settings.checks, Date.now()).kind === 'moved') return { status: 'missing' }
    // A local server may need no key; every catalog provider does.
    if (settings.apiKey === '' && route.provider.id !== CUSTOM_PROVIDER) return { status: 'missing' }
    return { status: 'ready', info: route.info, provider: route.provider, context }
  }, [failed, settings, route, context])
}
