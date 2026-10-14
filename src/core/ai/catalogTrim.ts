import { z } from 'zod'
import { baseUrlFor } from './baseUrls'

/** Packages the client knows how to load (see client.ts). */
export const SUPPORTED_NPM: ReadonlySet<string> = new Set([
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/openai-compatible',
  '@openrouter/ai-sdk-provider',
])

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
export interface CatalogModel {
  id: string
  name: string
  provider: string
  context_length: number
  output_limit?: number
  cost?: CatalogCost
  modalities: { input: string[] }
  capabilities: CatalogCapabilities
  release_date?: string
  status?: string
}
export interface CatalogProvider {
  id: string
  name: string
  npm?: string
  api: string | null
  browserCallable: boolean
  models: CatalogModel[]
}
export interface Catalog {
  generatedAt: string
  providers: CatalogProvider[]
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
}
export interface ProviderLike {
  id: string
  name: string
  npm?: string
  api?: string
  models: ModelLike[]
}

export function keepProvider(p: ProviderLike): boolean {
  return (p.npm !== undefined && SUPPORTED_NPM.has(p.npm)) || Boolean(p.api) || baseUrlFor(p.id) !== null
}

export function trimModel(m: ModelLike): CatalogModel {
  const caps: CatalogCapabilities = {}
  if (m.capabilities.reasoning) caps.reasoning = true
  if (m.capabilities.tool_call) caps.tool_call = true
  if (m.capabilities.structured_output) caps.structured_output = true
  if (m.capabilities.attachment) caps.attachment = true
  // llm-models prefixes ids with the provider; the API wants the bare id.
  const prefix = `${m.provider}/`
  const out: CatalogModel = {
    id: m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id,
    name: m.name,
    provider: m.provider,
    context_length: m.context_length,
    modalities: { input: [...m.modalities.input] },
    capabilities: caps,
  }
  if (m.output_limit !== undefined) out.output_limit = m.output_limit
  if (m.cost) out.cost = { input: m.cost.input, output: m.cost.output }
  if (m.release_date) out.release_date = m.release_date
  if (m.status) out.status = m.status
  return out
}

export function trimProvider(p: ProviderLike, browserCallable: boolean): CatalogProvider {
  const out: CatalogProvider = {
    id: p.id,
    name: p.name,
    api: p.api ?? null,
    browserCallable,
    models: p.models.filter((m) => m.status !== 'deprecated').map(trimModel),
  }
  if (p.npm) out.npm = p.npm
  return out
}

/** Base URL used for calls and for the CORS probe: the provider's own `api`, else the in-house table. */
export function providerBaseUrl(p: { id: string; api?: string | null }): string | null {
  return p.api ?? baseUrlFor(p.id)
}

const devModel = z.object({
  id: z.string(),
  name: z.string(),
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
        name: d.name,
        provider: p.data.id,
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
