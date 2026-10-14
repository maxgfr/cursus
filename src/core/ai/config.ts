import { findModel, modelsOf } from './catalog'
import { type Catalog, modelKey } from './catalogTrim'

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
}

export const DEFAULT_CONFIG: AiConfig = { language: 'auto' }

const LANGUAGES: readonly AiLanguage[] = ['auto', 'en', 'de', 'fr']

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
  return config
}
