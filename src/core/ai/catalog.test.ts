import { describe, expect, test } from 'bun:test'
import { probeBrowserSupport } from 'llm-models'
import {
  defaultRoute,
  findEntry,
  findModel,
  findProvider,
  isCurrentCatalog,
  loadBundledCatalog,
  MODELS_DEV_URL,
  modelsOf,
  orderedRoutes,
  recommendedModel,
  refreshCatalog,
  searchCatalog,
} from './catalog'
import {
  type BrowserCheck,
  browserVerdict,
  buildCatalog,
  type Catalog,
  checkEndpoint,
  clientBaseUrl,
  clientPackage,
  decodeCatalog,
  encodeCatalog,
  fromLlmModels,
  fromModelsDev,
  isBrowserCallable,
  keepProvider,
  type ModelLike,
  modelKey,
  type ProviderFacts,
  type ProviderLike,
} from './catalogTrim'
import { migrateConfig } from './config'
import { LOCAL_PROVIDER, LOCAL_PROVIDER_INFO } from './local'

const AT = '2026-10-14T00:00:00.000Z'
const ok: BrowserCheck = { verdict: 'callable', evidence: 'preflight', checkedAt: AT }
const blocked: BrowserCheck = { verdict: 'blocked', evidence: 'preflight', checkedAt: AT }

function model(provider: string, id: string, name: string, extra: Partial<ModelLike> = {}): ModelLike {
  return {
    id,
    name,
    provider,
    context_length: 200_000,
    output_limit: 64_000,
    modalities: { input: ['text'] },
    capabilities: { structured_output: true },
    release_date: '2026-10-07',
    ...extra,
  }
}

const haiku = (provider: string, id: string, price: number, name = 'Claude Haiku 5.5') =>
  model(provider, id, name, { cost: { input: price, output: price * 5 } })

/** Fifteen models from one maker, more than the old cap of five per provider. */
const many = Array.from({ length: 15 }, (_, i) => model('anthropic', `claude-x-${i}`, `Claude X ${i}`))

const PROVIDERS: ProviderLike[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    npm: '@ai-sdk/anthropic',
    models: [haiku('anthropic', 'anthropic/claude-haiku-5-5', 0.1, 'Anthropic: Claude Haiku 5.5'), ...many],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    npm: '@openrouter/ai-sdk-provider',
    api: 'https://openrouter.ai/api/v1',
    models: [
      haiku('openrouter', 'anthropic/claude-haiku-5.5', 0.12),
      model('openrouter', 'openai/gpt-x', 'OpenAI: GPT X'),
      model('openrouter', 'google/gemini-x', 'Google: Gemini X'),
    ],
  },
  {
    id: '302ai',
    name: '302.AI',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.302.ai/v1',
    models: [
      haiku('302ai', 'claude-haiku-5-5', 0.05),
      model('302ai', 'gpt-x', 'GPT X'),
      model('302ai', 'gemini-x', 'Gemini X'),
    ],
  },
  {
    id: 'walled',
    name: 'Walled',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://walled.example/v1',
    models: [haiku('walled', 'claude-haiku-5-5', 0.01)],
  },
  { id: 'bedrock', name: 'Bedrock', npm: '@ai-sdk/amazon-bedrock', models: [haiku('bedrock', 'claude-haiku', 1)] },
]

const facts =
  (overrides: Record<string, BrowserCheck> = {}) =>
  (p: ProviderLike): ProviderFacts => ({
    api: p.api ?? (p.id === 'anthropic' ? 'https://api.anthropic.com/v1' : null),
    baseUrlSource: p.api ? 'api' : p.id === 'anthropic' ? 'default' : 'none',
    browser: overrides[p.id] ?? (p.id === 'walled' ? blocked : ok),
  })

const build = (overrides: Record<string, BrowserCheck> = {}) => buildCatalog(PROVIDERS, facts(overrides), AT)

describe('buildCatalog', () => {
  test('lists a model once, with every route that serves it', () => {
    const c = build()
    const entry = findEntry(c, 'anthropic/claude-haiku-5-5')
    expect(entry?.name).toBe('Claude Haiku 5.5')
    expect(entry?.vendor).toBe('anthropic')
    expect(entry?.routes).toEqual([
      { provider: '302ai', id: 'claude-haiku-5-5', cost: { input: 0.05, output: 0.25 } },
      { provider: 'anthropic', id: 'claude-haiku-5-5', cost: { input: 0.1, output: 0.5 } },
      { provider: 'openrouter', id: 'anthropic/claude-haiku-5.5', cost: { input: 0.12, output: 0.6 } },
    ])
    expect(c.models.filter((m) => m.name === 'Claude Haiku 5.5')).toHaveLength(1)
    expect(c.vendors.anthropic).toBe('Anthropic')
  })

  test('keeps every model of a provider: no per-provider cap', () => {
    expect(modelsOf(build(), 'anthropic')).toHaveLength(16)
  })

  test('leaves out blocked providers and providers the client cannot load', () => {
    const ids = build().providers.map((p) => p.id)
    expect(ids).toEqual(['302ai', 'anthropic', 'openrouter'])
    expect(keepProvider({ id: 'b', npm: '@ai-sdk/amazon-bedrock' }, 'https://b/v1')).toBe(false)
    expect(build().blocked).toEqual({ walled: 'https://walled.example/v1' })
  })

  test('tells the maker, aggregators and hosts apart', () => {
    const kinds = Object.fromEntries(build().providers.map((p) => [p.id, p.kind]))
    expect(kinds).toEqual({ anthropic: 'vendor', openrouter: 'aggregator', '302ai': 'aggregator' })
  })

  test('folds spellings of one model id', () => {
    expect(modelKey('anthropic/claude-haiku-5.5')).toBe(modelKey('claude-haiku-5-5'))
    expect(modelKey('@cf/meta/Llama_3.1')).toBe('llama-3-1')
  })

  test('calls each provider by the id its own API accepts, leaving out what only OpenRouter serves', () => {
    const c = buildCatalog(
      fromLlmModels([
        {
          id: 'anthropic',
          name: 'Anthropic',
          npm: '@ai-sdk/anthropic',
          models: [
            model('anthropic', 'anthropic/claude-opus-4-1', 'Claude Opus 4.1', { api_id: 'claude-opus-4-1' }),
            // OpenRouter's spellings, listed under the vendor: Anthropic's API knows neither.
            model('anthropic', 'anthropic/claude-opus-4.1', 'Anthropic: Claude Opus 4.1'),
            model('anthropic', 'anthropic/claude-opus-4.1:batch', 'Anthropic: Claude Opus 4.1 (batch)'),
          ],
        },
        {
          id: 'openrouter',
          name: 'OpenRouter',
          npm: '@openrouter/ai-sdk-provider',
          api: 'https://openrouter.ai/api/v1',
          models: [model('openrouter', 'openrouter/openrouter/auto', 'Auto Router', { api_id: 'openrouter/auto' })],
        },
      ]),
      facts(),
      AT,
    )
    expect(modelsOf(c, 'anthropic').map((h) => h.route.id)).toEqual(['claude-opus-4-1'])
    // OpenRouter's own models keep their prefix: its API wants `openrouter/auto`, not `auto`.
    expect(modelsOf(c, 'openrouter').map((h) => h.route.id)).toEqual(['openrouter/auto'])
  })

  test('a model only resellers serve keeps the flags of its maker’s listing, even a retired one', () => {
    const reasons = { reasoning: true, tool_call: true }
    const c = buildCatalog(
      [
        {
          id: 'google',
          name: 'Google',
          npm: '@ai-sdk/google',
          api: 'https://generativelanguage.googleapis.com/v1beta',
          models: [
            model('google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', { status: 'deprecated', capabilities: reasons }),
          ],
        },
        {
          id: 'openrouter',
          name: 'OpenRouter',
          npm: '@openrouter/ai-sdk-provider',
          api: 'https://openrouter.ai/api/v1',
          models: [model('openrouter', 'google/gemini-2.5-flash', 'Google: Gemini 2.5 Flash', { capabilities: {} })],
        },
        {
          id: '302ai',
          name: '302.AI',
          npm: '@ai-sdk/openai-compatible',
          api: 'https://api.302.ai/v1',
          models: [model('302ai', 'gemini-2.5-flash', 'gemini-2.5-flash', { capabilities: {} })],
        },
      ],
      facts(),
      AT,
    )
    const [entry] = c.models
    expect(c.models).toHaveLength(1)
    expect(entry?.routes.map((r) => r.provider)).toEqual(['302ai', 'openrouter'])
    expect(entry?.capabilities).toEqual(reasons)
    expect(findModel(c, 'openrouter', 'google/gemini-2.5-flash')?.capabilities.reasoning).toBe(true)
  })

  test('catalog.json encoding round-trips', () => {
    const c = build()
    expect(decodeCatalog(encodeCatalog(c))).toEqual(c)
    expect(encodeCatalog(c).models[0]?.routes[0]).toBeArray()
  })
})

describe('routes', () => {
  test('default route: the maker’s own API when a browser can reach it, even if an aggregator is cheaper', () => {
    const c = build()
    const entry = findEntry(c, 'anthropic/claude-haiku-5-5')
    if (!entry) throw new Error('missing entry')
    expect(defaultRoute(c, entry)?.provider).toBe('anthropic')
    expect(orderedRoutes(c, entry).map((r) => r.provider)).toEqual(['anthropic', '302ai', 'openrouter'])
  })

  test('default route: else the cheapest browser-callable route; none when none is reachable', () => {
    const c = build({ anthropic: { verdict: 'unknown', evidence: 'none', checkedAt: AT } })
    const entry = findEntry(c, 'anthropic/claude-haiku-5-5')
    if (!entry) throw new Error('missing entry')
    expect(defaultRoute(c, entry)?.provider).toBe('302ai')
    const none = build({ anthropic: blocked, openrouter: blocked, '302ai': blocked })
    expect(none.models).toEqual([])
  })

  test('findModel resolves a route to the flat model the features price', () => {
    const m = findModel(build(), 'openrouter', 'anthropic/claude-haiku-5.5')
    expect(m).toMatchObject({ id: 'anthropic/claude-haiku-5.5', provider: 'openrouter', name: 'Claude Haiku 5.5' })
    expect(m?.cost).toEqual({ input: 0.12, output: 0.6 })
  })

  test('findProvider knows the on-device provider, which no catalog lists', () => {
    const c = build()
    expect(c.providers.some((p) => p.id === LOCAL_PROVIDER)).toBe(false)
    expect(findProvider(c, LOCAL_PROVIDER)).toEqual(LOCAL_PROVIDER_INFO)
    expect(findProvider(c, 'anthropic')?.id).toBe('anthropic')
    expect(findProvider(c, 'nobody')).toBeUndefined()
  })

  test('recommended model: the provider’s own, structured, newest', () => {
    const c = build()
    expect(recommendedModel(c, 'anthropic')?.route.id).toBe('claude-haiku-5-5')
    expect(recommendedModel(c, 'nobody')).toBeUndefined()
  })
})

describe('searchCatalog', () => {
  const opts = { structured: false, reachable: isBrowserCallable }

  test('no query: the chosen provider’s models, recommended first', () => {
    const groups = searchCatalog(build(), '', { ...opts, providerId: 'anthropic' })
    expect(groups.map((g) => g.provider.id)).toEqual(['anthropic'])
    expect(groups[0]?.hits[0]?.route.id).toBe('claude-haiku-5-5')
    expect(groups[0]?.hits).toHaveLength(16)
  })

  test('a provider name lists that provider', () => {
    const groups = searchCatalog(build(), '302', opts)
    expect(groups.map((g) => g.provider.id)).toEqual(['302ai'])
    expect(groups[0]?.hits).toHaveLength(3)
  })

  test('a model name lists every provider offering it, the maker’s API first', () => {
    const groups = searchCatalog(build(), 'haiku 5.5', opts)
    expect(groups.map((g) => g.provider.id)).toEqual(['anthropic', '302ai', 'openrouter'])
  })

  test('provider and model words combine', () => {
    const groups = searchCatalog(build(), '302 haiku', opts)
    expect(groups.map((g) => g.provider.id)).toEqual(['302ai'])
    expect(groups[0]?.hits.map((h) => h.route.id)).toEqual(['claude-haiku-5-5'])
  })

  test('filters: structured output and reachability', () => {
    const c = build()
    expect(searchCatalog(c, 'haiku', { structured: true, reachable: (p) => p.id !== '302ai' }).length).toBe(2)
    expect(searchCatalog(c, 'nothing-like-this', opts)).toEqual([])
  })
})

describe('browser verdict', () => {
  const ORIGIN = 'https://maxgfr.github.io'
  const probe = async (id: string, api: string, answer: (req: Request) => Response) => {
    const fake = (async (input: string | URL | Request, init?: RequestInit) =>
      answer(new Request(String(input instanceof Request ? input.url : input), init))) as typeof fetch
    return browserVerdict(
      id,
      await probeBrowserSupport({ id, api }, { origin: ORIGIN, fetch: fake, now: () => new Date(AT) }),
    )
  }
  const cors = (extra: Record<string, string> = {}) => ({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    ...extra,
  })

  test('a 404 preflight is refused even with Access-Control-Allow-Origin: *', async () => {
    const v = await probe('x', 'https://x.example/v1', () => new Response(null, { status: 404, headers: cors() }))
    expect(v.verdict).toBe('blocked')
  })

  test('a 200 preflight that does not allow Authorization is refused', async () => {
    const v = await probe(
      'x',
      'https://x.example/v1',
      () => new Response(null, { status: 200, headers: cors({ 'access-control-allow-headers': 'content-type' }) }),
    )
    expect(v.verdict).toBe('blocked')
  })

  test('a 2xx preflight allowing the origin and headers is callable', async () => {
    const v = await probe('x', 'https://x.example/v1', () => new Response(null, { status: 204, headers: cors() }))
    expect(v).toEqual({ verdict: 'callable', evidence: 'preflight', checkedAt: AT })
  })

  test('Anthropic is callable only with its direct-browser header', async () => {
    const v = await probe(
      'anthropic',
      'https://api.anthropic.com/v1',
      () =>
        new Response(null, {
          status: 200,
          headers: cors({
            'access-control-allow-headers':
              'anthropic-dangerous-direct-browser-access, anthropic-version, content-type, x-api-key',
          }),
        }),
    )
    expect(v.verdict).toBe('callable_with_header')
    expect(v.headers).toEqual({ 'anthropic-dangerous-direct-browser-access': 'true' })
  })

  test('Cerebras: callable, with unreadable errors noted', () => {
    const v = browserVerdict('cerebras', { callable: true, evidence: 'preflight', checked_at: AT })
    expect(v.limits).toBe('unreadable_errors')
    expect(browserVerdict('x', { callable: false, evidence: 'none', checked_at: AT }).verdict).toBe('unknown')
  })
})

describe('config migration', () => {
  test('keeps the stored route and maps a respelled model id', () => {
    const c = build()
    expect(migrateConfig({ providerId: 'anthropic', modelId: 'claude-haiku-5-5', language: 'fr' }, c)).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-haiku-5-5',
      language: 'fr',
    })
    expect(migrateConfig({ providerId: 'anthropic', modelId: 'claude-haiku-5.5', language: 'auto' }, c).modelId).toBe(
      'claude-haiku-5-5',
    )
  })

  test('never drops a choice the catalog no longer knows, and survives junk', () => {
    const c = build()
    expect(migrateConfig({ providerId: 'ai21', modelId: 'jamba-mini', baseUrl: 'https://p/v1' }, c)).toEqual({
      providerId: 'ai21',
      modelId: 'jamba-mini',
      baseUrl: 'https://p/v1',
      language: 'auto',
    })
    expect(migrateConfig(undefined, c)).toEqual({ language: 'auto' })
    expect(migrateConfig({ language: 'xx', providerId: 3 }, c)).toEqual({ language: 'auto' })
  })

  test('keeps each route’s effort and drops anything unknown', () => {
    const c = build()
    const efforts = { 'anthropic/claude-haiku-5-5': 'max', 'openai/gpt-5': 'minimal', 'x/y': 'huge', 'x/z': 2 }
    expect(migrateConfig({ language: 'auto', efforts }, c)).toEqual({
      language: 'auto',
      efforts: { 'anthropic/claude-haiku-5-5': 'max', 'openai/gpt-5': 'minimal' },
    })
    expect(migrateConfig({ language: 'auto', efforts: 'high' }, c)).toEqual({ language: 'auto' })
  })

  test('reads the single effort of the unreleased build as the choice for the model it was set with', () => {
    const c = build()
    const route = { providerId: 'anthropic', modelId: 'claude-haiku-5-5', language: 'auto' } as const
    expect(migrateConfig({ ...route, effort: 'high' }, c)).toEqual({
      ...route,
      efforts: { 'anthropic/claude-haiku-5-5': 'high' },
    })
    // A choice already kept for that model wins; without a model, the old value has nowhere to go.
    const kept = { 'anthropic/claude-haiku-5-5': 'low' } as const
    expect(migrateConfig({ ...route, effort: 'high', efforts: kept }, c).efforts).toEqual(kept)
    expect(migrateConfig({ language: 'auto', effort: 'high' }, c)).toEqual({ language: 'auto' })
    expect(migrateConfig({ ...route, effort: 'huge' }, c)).toEqual(route)
  })

  test('a respelled model id keeps its effort', () => {
    const c = build()
    const raw = {
      providerId: 'anthropic',
      modelId: 'claude-haiku-5.5',
      efforts: { 'anthropic/claude-haiku-5.5': 'low' },
    }
    expect(migrateConfig(raw, c).efforts).toEqual({ 'anthropic/claude-haiku-5-5': 'low' })
  })
})

const FIXTURE = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    npm: '@ai-sdk/openai',
    models: {
      'gpt-x': {
        id: 'gpt-x',
        name: 'GPT X',
        release_date: '2026-01-01',
        structured_output: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 1, output: 4, cache_read: 0.1 },
        limit: { context: 400000, output: 128000 },
      },
      broken: { id: 'broken' },
    },
  },
  newcomer: {
    id: 'newcomer',
    name: 'Newcomer',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://new.example/v1',
    models: { 'gpt-x': { id: 'gpt-x', name: 'GPT X', limit: { context: 1000 } } },
  },
  tiny: {
    id: 'tiny',
    name: 'Tiny',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://tiny.example/v1',
    models: { t1: { id: 't1', name: 'T1', limit: { context: 1000 }, status: 'deprecated' } },
  },
  garbage: 42,
}

const PREVIOUS: Catalog = {
  version: 3,
  generatedAt: AT,
  vendors: {},
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      api: 'https://api.openai.com/v1',
      baseUrlSource: 'default',
      kind: 'vendor',
      browser: ok,
    },
  ],
  models: [],
  blocked: { walled: 'https://walled.example/v1' },
}

describe('catalog', () => {
  test('bundled catalog: well formed, uncapped, small once gzipped', async () => {
    const bytes = await Bun.file(new URL('./catalog.json', import.meta.url)).bytes()
    expect(Bun.gzipSync(bytes).byteLength).toBeLessThanOrEqual(300 * 1024)
    const c = await loadBundledCatalog()
    expect(isCurrentCatalog(c)).toBe(true)
    expect(c.providers.filter(isBrowserCallable).length).toBeGreaterThan(0)
    expect(c.providers.some((p) => p.browser.verdict === 'blocked')).toBe(false)
    expect(modelsOf(c, 'anthropic').length).toBeGreaterThan(5)
    const ids = c.models.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    const claude = c.models.find((m) => m.vendor === 'anthropic' && m.routes.some((r) => r.provider === 'anthropic'))
    if (!claude) throw new Error('no Claude model')
    expect(defaultRoute(c, claude)?.provider).toBe('anthropic')
  })

  test('an older stored catalog is not current', () => {
    expect(isCurrentCatalog({ generatedAt: AT, providers: [] })).toBe(false)
  })

  test('normalizes models.dev, skipping malformed entries and deprecated models', () => {
    const ps = fromModelsDev(FIXTURE)
    expect(ps.map((p) => p.id)).toEqual(['openai', 'newcomer', 'tiny'])
    expect(ps[0]?.models).toHaveLength(1)
    expect(ps[0]?.models[0]?.cost).toEqual({ input: 1, output: 4 })
    expect(() => fromModelsDev([1, 2])).toThrow()
  })

  test('models.dev ids are the ones the provider’s API accepts, prefix included', () => {
    const ps = fromModelsDev({
      openrouter: {
        id: 'openrouter',
        name: 'OpenRouter',
        npm: '@openrouter/ai-sdk-provider',
        api: 'https://openrouter.ai/api/v1',
        models: { 'openrouter/auto': { id: 'openrouter/auto', name: 'Auto Router', limit: { context: 2000000 } } },
      },
    })
    const c = buildCatalog(ps, facts(), AT)
    expect(modelsOf(c, 'openrouter').map((h) => h.route.id)).toEqual(['openrouter/auto'])
  })

  test('refreshCatalog GETs models.dev, keeps known verdicts and marks newcomers unknown', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(FIXTURE))
    }) as typeof fetch
    const c = await refreshCatalog(PREVIOUS, fake, () => 0)
    expect(calls).toEqual([{ url: MODELS_DEV_URL, init: undefined }])
    expect(c.version).toBe(3)
    expect(c.generatedAt).toBe('1970-01-01T00:00:00.000Z')
    expect(c.providers.map((p) => [p.id, p.browser.verdict, p.api])).toEqual([
      ['newcomer', 'unknown', 'https://new.example/v1'],
      ['openai', 'callable', 'https://api.openai.com/v1'],
      ['tiny', 'unknown', 'https://tiny.example/v1'],
    ])
    expect(findEntry(c, 'openai/gpt-x')?.routes.map((r) => r.provider)).toEqual(['newcomer', 'openai'])
    expect(findModel(c, 'openai', 'gpt-x')?.context_length).toBe(400000)
  })

  test('refreshCatalog surfaces HTTP failures', async () => {
    const fake = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch
    await expect(refreshCatalog(PREVIOUS, fake)).rejects.toThrow('503')
  })
})

describe('wire protocol', () => {
  test('keeps only providers the client speaks to, at an https address', () => {
    expect(clientPackage({ id: 'x', npm: '@ai-sdk/openai-compatible' })).toBe('@ai-sdk/openai-compatible')
    expect(clientPackage({ id: 'mistral', npm: '@ai-sdk/mistral' })).toBe('@ai-sdk/openai-compatible')
    expect(clientPackage({ id: 'minimax', npm: '@ai-sdk/anthropic' })).toBe('@ai-sdk/anthropic')
    // An unknown SDK or no package at all: we would be guessing the protocol.
    expect(clientPackage({ id: 'venice', npm: 'venice-ai-sdk-provider' })).toBeNull()
    expect(clientPackage({ id: 'qwen' })).toBeNull()
    expect(keepProvider({ id: 'x', npm: '@ai-sdk/openai-compatible' }, 'http://x.example/v1')).toBe(false)
    expect(keepProvider({ id: 'x', npm: '@ai-sdk/openai-compatible' }, 'https://x.example/v1')).toBe(true)
  })

  test('Cohere is called on its OpenAI-compatible API, not its native v2', () => {
    expect(clientPackage({ id: 'cohere', npm: '@ai-sdk/cohere' })).toBe('@ai-sdk/openai-compatible')
    expect(clientBaseUrl({ id: 'cohere', api: null }, 'https://api.cohere.com/v2')).toBe(
      'https://api.cohere.ai/compatibility/v1',
    )
  })

  test('custom endpoints: https anywhere, plain http only on this machine', () => {
    expect(checkEndpoint('https://ollama.example.com/v1')).toBe('ok')
    expect(checkEndpoint('http://localhost:11434/v1')).toBe('ok')
    expect(checkEndpoint('http://127.0.0.1:1234/v1')).toBe('ok')
    expect(checkEndpoint('http://192.168.1.20:11434/v1')).toBe('insecure')
    expect(checkEndpoint('localhost:11434')).toBe('invalid')
    expect(checkEndpoint('ftp://x')).toBe('invalid')
  })
})

describe('refresh keeps what the build learned', () => {
  const devPayload = (api: Record<string, string | undefined>) =>
    Object.fromEntries(
      Object.entries(api).map(([id, url]) => [
        id,
        {
          id,
          name: id,
          npm: '@ai-sdk/openai-compatible',
          ...(url ? { api: url } : {}),
          models: { m: { id: 'm', name: 'M', limit: { context: 1000 } } },
        },
      ]),
    )
  const fetchOf = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
  const previous = (): Catalog => ({
    ...PREVIOUS,
    providers: [
      { ...(PREVIOUS.providers[0] as Catalog['providers'][number]), id: 'kept', api: 'https://kept.example/v1' },
    ],
  })

  test('a provider the build found blocked stays out', async () => {
    const c = await refreshCatalog(previous(), fetchOf(devPayload({ walled: 'https://walled.example/v1' })), () => 0)
    expect(c.providers.map((p) => p.id)).toEqual([])
    expect(c.blocked).toEqual({ walled: 'https://walled.example/v1' })
  })

  test('a changed address is a new server: unknown, and the old address is remembered', async () => {
    const c = await refreshCatalog(
      previous(),
      fetchOf(devPayload({ kept: 'https://elsewhere.example/v1', walled: 'https://walled2.example/v1' })),
      () => 0,
    )
    const kept = c.providers.find((p) => p.id === 'kept')
    expect(kept?.browser.verdict).toBe('unknown')
    expect(kept?.previousApi).toBe('https://kept.example/v1')
    expect(c.providers.find((p) => p.id === 'walled')?.previousApi).toBe('https://walled.example/v1')
  })

  test('an unchanged address keeps its verdict; an http address is dropped', async () => {
    const c = await refreshCatalog(
      previous(),
      fetchOf(devPayload({ kept: 'https://kept.example/v1', plain: 'http://plain.example/v1' })),
      () => 0,
    )
    expect(c.providers.map((p) => [p.id, p.browser.verdict, p.previousApi])).toEqual([['kept', 'callable', undefined]])
  })
})
