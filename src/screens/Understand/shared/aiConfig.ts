import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRuntime, useWorkspace } from '../../../app/workspaceContext.tsx'
import { bundledCatalog, findModel, findProvider } from '../../../core/ai/catalog'
import type { Catalog, CatalogModel, CatalogProvider } from '../../../core/ai/catalogTrim'
import { createModel, type FeatureCtx, outputLanguage } from '../../../core/ai/client'
import { costOf } from '../../../core/ai/cost'
import type { AiUsageEvent } from '../../../core/ai/usage'
import type { ModelWorkspace } from '../../../core/model/workspace'
import { type Secrets, secretsVault } from '../../../core/storage/secrets'
import { useLocale } from '../../../i18n/react.tsx'

export type AiLanguage = 'auto' | 'en' | 'de' | 'fr'

/** Device-only AI settings. They live in the vault next to the key, never in the synced doc. */
export interface AiConfig {
  providerId?: string
  modelId?: string
  /** Overrides the provider's base URL (proxies, self-hosted gateways). */
  baseUrl?: string
  language: AiLanguage
}

const CONFIG = 'ai-config'
const CATALOG = 'ai-catalog'
const keyName = (providerId: string) => `ai-key-${providerId}`

export const DEFAULT_CONFIG: AiConfig = { language: 'auto' }

export function useVault(): Secrets {
  const rt = useRuntime()
  return useMemo(() => secretsVault(rt.store), [rt])
}

export interface AiSettings {
  config: AiConfig
  catalog: Catalog
  /** Key of the selected provider, if any. */
  apiKey: string
}

export async function loadAiSettings(vault: Secrets): Promise<AiSettings> {
  const config = { ...DEFAULT_CONFIG, ...((await vault.get<AiConfig>(CONFIG)) ?? {}) }
  const catalog = (await vault.get<Catalog>(CATALOG)) ?? bundledCatalog()
  const apiKey = config.providerId ? ((await vault.get<string>(keyName(config.providerId))) ?? '') : ''
  return { config, catalog, apiKey }
}

export const saveConfig = (vault: Secrets, config: AiConfig) => vault.set(CONFIG, config)
export const saveCatalog = (vault: Secrets, catalog: Catalog) => vault.set(CATALOG, catalog)
export async function saveKey(vault: Secrets, providerId: string, key: string): Promise<void> {
  if (key.trim() === '') await vault.delete(keyName(providerId))
  else await vault.set(keyName(providerId), key.trim())
}
export const loadKey = async (vault: Secrets, providerId: string) =>
  (await vault.get<string>(keyName(providerId))) ?? ''

/** The provider as the client should call it, with the user's base URL applied. */
export function effectiveProvider(provider: CatalogProvider, baseUrl: string | undefined): CatalogProvider {
  const url = baseUrl?.trim()
  return url ? { ...provider, api: url } : provider
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

  const context = useCallback(
    async (signal: AbortSignal, courseLanguage?: string): Promise<FeatureCtx> => {
      if (!settings) throw new Error('AI settings are not loaded')
      const { config, catalog, apiKey } = settings
      const provider = findProvider(catalog, config.providerId ?? '')
      const info = findModel(catalog, config.providerId ?? '', config.modelId ?? '')
      if (!provider || !info) throw new Error('No model selected')
      const model = await createModel({
        provider: effectiveProvider(provider, config.baseUrl),
        modelId: info.id,
        apiKey,
      })
      return {
        model,
        info,
        language: languageName(config, courseLanguage, locale === 'pseudo' ? 'en' : locale),
        signal,
        onUsage: (e) => recordUsage(ws, e),
      }
    },
    [settings, ws, locale],
  )

  return useMemo((): AiModelState => {
    if (failed) return { status: 'missing' }
    if (!settings) return { status: 'loading' }
    const { config, catalog, apiKey } = settings
    const provider = findProvider(catalog, config.providerId ?? '')
    const info = findModel(catalog, config.providerId ?? '', config.modelId ?? '')
    if (!provider || !info || !provider.browserCallable || apiKey === '') return { status: 'missing' }
    return { status: 'ready', info, provider, context }
  }, [failed, settings, context])
}
