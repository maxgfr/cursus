import { findModel, modelsOf } from './catalog'
import { type Catalog, modelKey } from './catalogTrim'
import { type AiEffort, EFFORTS } from './effort'

export type AiLanguage = 'auto' | 'en' | 'de' | 'fr'

/** Provider id of the user's own OpenAI-compatible endpoint (Ollama, LM Studio, a proxy…). */
export const CUSTOM_PROVIDER = 'custom'

/**
 * Device-only AI settings. They live in the vault next to the key, never in the synced doc.
 * The route is the pair (`providerId`, `modelId`): which provider is called, with its own id for the model.
 */
export interface AiConfig {
  providerId?: string
  /** The provider's id for the model (for the custom endpoint, whatever the server expects). */
  modelId?: string
  /** Overrides the provider's base URL (proxies, self-hosted gateways); required for the custom endpoint. */
  baseUrl?: string
  language: AiLanguage
  /** The effort chosen for each route, keyed by `effortKey`; a route without one runs at the model's default. */
  efforts?: Record<string, AiEffort>
}

export const DEFAULT_CONFIG: AiConfig = { language: 'auto' }

const LANGUAGES: readonly AiLanguage[] = ['auto', 'en', 'de', 'fr']

const isEffort = (v: unknown): v is AiEffort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)

/** The key a route's effort is saved under: provider ids hold no `/`, so the first one splits it. */
export function effortKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/** The effort saved for the selected route, whether or not its model still takes it (see `usableEffort`). */
export function savedEffort(config: AiConfig): AiEffort | undefined {
  if (!config.providerId || !config.modelId) return undefined
  return config.efforts?.[effortKey(config.providerId, config.modelId)]
}

/** Saves the effort for the selected route; `undefined` goes back to the model's default. */
export function withEffort(config: AiConfig, effort: AiEffort | undefined): AiConfig {
  if (!config.providerId || !config.modelId) return config
  const key = effortKey(config.providerId, config.modelId)
  const next: AiConfig = { ...config, efforts: { ...config.efforts } }
  if (effort) next.efforts = { ...next.efforts, [key]: effort }
  else delete next.efforts?.[key]
  if (Object.keys(next.efforts ?? {}).length === 0) delete next.efforts
  return next
}

/**
 * Reads a stored config, whatever version wrote it, without losing the choice. Earlier versions
 * stored the same route pair; a model id the catalog now spells differently (`5.5` vs `5-5`) is
 * mapped to the provider's current spelling, and an unknown one is kept as typed.
 */
export function migrateConfig(raw: unknown, catalog: Catalog): AiConfig {
  const config: AiConfig = { ...DEFAULT_CONFIG }
  if (typeof raw !== 'object' || raw === null) return config
  const r = raw as Record<string, unknown>
  if (typeof r.language === 'string' && (LANGUAGES as readonly string[]).includes(r.language)) {
    config.language = r.language as AiLanguage
  }
  const efforts: Record<string, AiEffort> = {}
  if (typeof r.efforts === 'object' && r.efforts !== null) {
    for (const [key, v] of Object.entries(r.efforts)) if (isEffort(v)) efforts[key] = v
  }
  if (Object.keys(efforts).length > 0) config.efforts = efforts
  if (typeof r.baseUrl === 'string' && r.baseUrl.trim() !== '') config.baseUrl = r.baseUrl
  if (typeof r.providerId !== 'string' || r.providerId === '') return config
  config.providerId = r.providerId
  if (typeof r.modelId !== 'string' || r.modelId === '') return config
  config.modelId = r.modelId
  if (r.providerId !== CUSTOM_PROVIDER && !findModel(catalog, r.providerId, r.modelId)) {
    const key = modelKey(r.modelId)
    const same = modelsOf(catalog, r.providerId).find(({ route }) => modelKey(route.id) === key)
    if (same) config.modelId = same.route.id
  }
  // The effort follows a respelled id; a single one, from before efforts were kept per model, is the choice
  // for the model it was set with.
  const stored = effortKey(r.providerId, r.modelId)
  const saved = config.efforts?.[stored] ?? (isEffort(r.effort) ? r.effort : undefined)
  if (config.modelId !== r.modelId) delete config.efforts?.[stored]
  return saved && !savedEffort(config) ? withEffort(config, saved) : config
}
