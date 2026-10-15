import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRuntime, useWorkspace } from '../../../app/workspaceContext.tsx'
import { findModel, findProvider, isCurrentCatalog, loadBundledCatalog } from '../../../core/ai/catalog'
import type { Catalog, CatalogModel, CatalogProvider } from '../../../core/ai/catalogTrim'
import { createModel, type FeatureCtx, outputLanguage } from '../../../core/ai/client'
import { type AiConfig, CUSTOM_PROVIDER, migrateConfig } from '../../../core/ai/config'
import { costOf } from '../../../core/ai/cost'
import { checkKey, type DeviceCheck, type DeviceChecks, routeStatus } from '../../../core/ai/deviceCheck'
import { LOCAL_PROVIDER, LOCAL_PROVIDER_INFO } from '../../../core/ai/local'
import type { AiUsageEvent } from '../../../core/ai/usage'
import { detectLanguage } from '../../../core/content/language'
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

/** The text the AI works on: one text, or several from the most specific (the card) to the broadest (the course). */
export type AiContent = string | readonly (string | undefined)[]

/** The text of passages (chunks of sources), as content to detect a language on. */
export function passagesText(chunks: readonly { text: string }[]): string {
  return chunks.map((c) => c.text).join('\n')
}

/** The two faces of a card, as content to detect a language on. */
export function cardText(card: { front: string; back: string } | undefined): string | undefined {
  return card === undefined ? undefined : `${card.front}\n${card.back}`
}

/** Enough of a course's own text to tell its language: written notes first, then cards. */
const COURSE_SAMPLE_CHARS = 8_000

/** A course's notes and cards, as content to detect a language on (files read in the app are not in the doc). */
export function courseText(ws: ModelWorkspace, courseId: string): string {
  const parts: string[] = []
  let size = 0
  const push = (text: string) => {
    if (size >= COURSE_SAMPLE_CHARS || text.trim() === '') return
    parts.push(text)
    size += text.length
  }
  for (const s of ws.sources.list({ courseId })) {
    if (s.kind === 'note' && s.support === undefined) push(ws.text({ id: s.id, field: 'body' }).toString())
  }
  for (const c of ws.cards.list({ courseId })) {
    push(`${ws.text({ id: c.id, field: 'front' }).toString()}\n${ws.text({ id: c.id, field: 'back' }).toString()}`)
  }
  return parts.join('\n')
}

/** The language of the first part that tells, else of all of them together. */
export function contentLanguage(content: AiContent | undefined): string | undefined {
  if (content === undefined) return undefined
  if (typeof content === 'string') return detectLanguage(content)
  for (const part of content) {
    const found = detectLanguage(part)
    if (found) return found
  }
  return detectLanguage(content.filter((p) => p !== undefined).join('\n'))
}

/**
 * The language the AI writes in: the one forced in Settings › AI, else the course's own, else the language the
 * content is written in (detected on `content`: the sources, the card, the open source), else the interface's.
 */
export function languageName(
  config: AiConfig,
  courseLanguage: string | undefined,
  uiLocale: string,
  content?: AiContent,
): string {
  if (config.language !== 'auto') return outputLanguage(undefined, config.language)
  if (courseLanguage?.trim()) return outputLanguage(courseLanguage, uiLocale)
  return outputLanguage(contentLanguage(content), uiLocale)
}

/**
 * Records a usage event in the workspace as `provider/model` so its cost can be priced later, with the source it
 * was spent on when there is one.
 */
export function recordUsage(ws: ModelWorkspace, e: AiUsageEvent): void {
  ws.aiUsage.record({
    model: `${e.provider}/${e.model}`,
    inTok: e.inputTokens,
    outTok: e.outputTokens,
    ...(e.sourceId === undefined ? {} : { src: e.sourceId }),
  })
}

/** Cost of the synced usage events `keep` selects, priced with the current catalog (on-device: nothing). */
function usageCost(
  ws: ModelWorkspace,
  catalog: Catalog,
  keep: (e: ReturnType<ModelWorkspace['aiUsage']['list']>[number]) => boolean,
): number {
  let total = 0
  for (const e of ws.aiUsage.list()) {
    if (!keep(e)) continue
    const slash = e.model.indexOf('/')
    if (slash > 0 && e.model.slice(0, slash) === LOCAL_PROVIDER) continue
    const info = slash > 0 ? findModel(catalog, e.model.slice(0, slash), e.model.slice(slash + 1)) : undefined
    total += costOf({ inputTokens: e.inTok, outputTokens: e.outTok }, info?.cost)
  }
  return total
}

/** Cost of this month's usage, priced with the current catalog (an on-device model costs nothing). */
export function monthCostOf(ws: ModelWorkspace, catalog: Catalog, now: number): number {
  const d = new Date(now)
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  return usageCost(ws, catalog, (e) => e.at >= start && e.at < end)
}

/** What a source cost so far on every device (usage synced with its source), priced with the current catalog. */
export function sourceCostOf(ws: ModelWorkspace, catalog: Catalog, sourceId: string): number {
  return usageCost(ws, catalog, (e) => e.src === sourceId)
}

/** Why no model can be called: nothing chosen, no key, the on-device model not downloaded, or the provider moved. */
export type MissingReason = 'none' | 'noKey' | 'notDownloaded' | 'moved'

export type AiModelState =
  | { status: 'loading' }
  | { status: 'missing'; reason: MissingReason }
  | {
      status: 'ready'
      info: CatalogModel
      provider: CatalogProvider
      /** The model runs in this browser: it needs no connection (nor a key). */
      runsOffline: boolean
      /**
       * Builds a feature context. In auto, the output language is `courseLanguage` when set, else the language of
       * `content` (the text the AI works on), else the interface's.
       */
      context(signal: AbortSignal, courseLanguage?: string, content?: AiContent): Promise<FeatureCtx>
    }

/**
 * The selected model, ready to call, or `missing` when no model or key is set up. An on-device model
 * needs no key, but must be downloaded on this device.
 */
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

  const route = useMemo(() => {
    if (!settings) return undefined
    const local = settings.local
    return resolveRoute(settings.config, settings.catalog, CUSTOM_PROVIDER, (id) =>
      local?.info.id === id ? local.info : undefined,
    )
  }, [settings])

  const context = useCallback(
    async (signal: AbortSignal, courseLanguage?: string, content?: AiContent): Promise<FeatureCtx> => {
      if (!settings) throw new Error('AI settings are not loaded')
      if (!route) throw new Error('No model selected')
      const model = await createModel({ provider: route.provider, modelId: route.info.id, apiKey: settings.apiKey })
      return {
        model,
        info: route.info,
        language: languageName(settings.config, courseLanguage, locale === 'pseudo' ? 'en' : locale, content),
        signal,
        onUsage: (e) => recordUsage(ws, e),
      }
    },
    [settings, route, ws, locale],
  )

  return useMemo((): AiModelState => {
    if (failed) return { status: 'missing', reason: 'none' }
    if (!settings) return { status: 'loading' }
    if (!route) return { status: 'missing', reason: 'none' }
    if (route.provider.id === LOCAL_PROVIDER) {
      if (!settings.local?.downloaded) return { status: 'missing', reason: 'notDownloaded' }
      return { status: 'ready', info: route.info, provider: route.provider, runsOffline: true, context }
    }
    // A route this device saw blocked stays on: the settings show it and offer a new test. A
    // provider that moved to an unchecked address gets no key until the user tests it there.
    if (routeStatus(route.provider, settings.checks, Date.now()).kind === 'moved')
      return { status: 'missing', reason: 'moved' }
    // A local server may need no key; every catalog provider does.
    if (settings.apiKey === '' && route.provider.id !== CUSTOM_PROVIDER) return { status: 'missing', reason: 'noKey' }
    return { status: 'ready', info: route.info, provider: route.provider, runsOffline: false, context }
  }, [failed, settings, route, context])
}
