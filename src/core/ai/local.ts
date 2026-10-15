/**
 * The "On this device" provider: a model that runs in the page's GPU (WebGPU) through WebLLM, in a
 * Web Worker. This module is the engine-agnostic half, shared by the page and the worker: device
 * detection, the space check, the weight cache, the worker protocol and a fake engine. It imports
 * nothing heavy; llm-models and the service live in localModels.ts, WebLLM in the worker only.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider'
import type { CatalogProvider } from './catalogTrim'

/** Provider id of models that run on this device. */
export const LOCAL_PROVIDER = 'on-device'

/** The provider as the client and the settings see it: keyless, nothing leaves the device. */
export const LOCAL_PROVIDER_INFO: CatalogProvider = {
  id: LOCAL_PROVIDER,
  name: 'On this device',
  api: null,
  baseUrlSource: 'none',
  kind: 'host',
  browser: { verdict: 'callable', evidence: 'none', checkedAt: '1970-01-01T00:00:00.000Z' },
}

// ---------------------------------------------------------------------------------------------
// Errors

export type LocalErrorCode =
  /** The model is not one the engine can run. */
  | 'unsupported-model'
  /** Its weights are not (all) in the cache: download it first. */
  | 'not-downloaded'
  /** The download would eat into the space the library needs; `space` says by how much. */
  | 'no-space'
  /** The engine failed (WebGPU lost, a file missing after the download…). */
  | 'engine'

export class LocalModelError extends Error {
  constructor(
    readonly code: LocalErrorCode,
    message: string,
    readonly space?: SpaceVerdict,
  ) {
    super(message)
    this.name = 'LocalModelError'
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

// ---------------------------------------------------------------------------------------------
// Detection

/** The parts of a WebGPU adapter detection reads (structural, so tests can fake it). */
export interface AdapterLike {
  readonly limits: {
    readonly maxBufferSize: number
    readonly maxStorageBufferBindingSize: number
    readonly maxComputeWorkgroupStorageSize: number
  }
  readonly features: { has(name: string): boolean }
  readonly info?: { readonly vendor?: string; readonly architecture?: string }
}
export interface GpuLike {
  requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<AdapterLike | null>
}
/** What the browser exposes: `navigator.gpu` and Chromium's `navigator.deviceMemory` (GiB). */
export interface DetectEnv {
  gpu?: GpuLike | undefined
  deviceMemory?: number | undefined
}

export type LocalUnsupportedReason = 'no-webgpu' | 'no-adapter' | 'too-little-memory'

export interface GpuReport {
  vendor: string
  architecture: string
  maxBufferSize: number
  maxStorageBufferBindingSize: number
  maxComputeWorkgroupStorageSize: number
  /** fp16 compute (`shader-f16`): WebLLM's q4f16 builds need it. */
  shaderF16: boolean
  /** RAM the browser reports (Chromium only, rounded and capped at 8 GiB); null when it does not say. */
  deviceMemoryGiB: number | null
  /** GPU memory a model may take, estimated: WebGPU does not expose it. */
  memoryBudgetMB: number
  memorySource: 'device-memory' | 'default'
  /** The adapter binds less than 1 GiB per storage buffer: only WebLLM's low-resource builds load. */
  lowResource: boolean
}

export type LocalDetection =
  | { supported: true; gpu: GpuReport }
  | { supported: false; reason: LocalUnsupportedReason; gpu?: GpuReport }

const MiB = 1024 * 1024
const GiB = 1024 * MiB
/**
 * WebLLM refuses to start below these adapter limits (`detectGPUDevice` in @mlc-ai/web-llm: it asks
 * for 1 GiB buffers, falls back to 256 MiB buffers and 128 MiB storage bindings, needs 32 KiB of
 * workgroup storage) and warns that only a few models work below 1 GiB storage bindings.
 */
export const WEBLLM_MIN_BUFFER = 256 * MiB
export const WEBLLM_MIN_STORAGE_BINDING = 128 * MiB
export const WEBLLM_MIN_WORKGROUP_STORAGE = 32 * 1024
export const WEBLLM_FULL_STORAGE_BINDING = GiB
/**
 * Share of RAM a model may take when the browser reports RAM. Apple GPUs share RAM with the system
 * and Metal keeps a working set well below it; half leaves the OS, the browser and the app their part.
 */
export const GPU_SHARE_OF_RAM = 0.5
/**
 * Budget when RAM is unknown (Safari never reports it, and iPadOS passes for a Mac): sized for the
 * smallest device the app targets, an iPhone, whose web pages are killed well before RAM is full.
 */
export const UNKNOWN_MEMORY_BUDGET_MB = 2048

/** Whether this device can run a model, and how much GPU memory one may take. */
export async function detectLocalSupport(env: DetectEnv): Promise<LocalDetection> {
  if (!env.gpu) return { supported: false, reason: 'no-webgpu' }
  const adapter = await env.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) return { supported: false, reason: 'no-adapter' }
  const limits = adapter.limits
  const memory = typeof env.deviceMemory === 'number' && env.deviceMemory > 0 ? env.deviceMemory : null
  const gpu: GpuReport = {
    vendor: adapter.info?.vendor ?? '',
    architecture: adapter.info?.architecture ?? '',
    maxBufferSize: limits.maxBufferSize,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize,
    shaderF16: adapter.features.has('shader-f16'),
    deviceMemoryGiB: memory,
    memoryBudgetMB: memory === null ? UNKNOWN_MEMORY_BUDGET_MB : Math.floor(memory * 1024 * GPU_SHARE_OF_RAM),
    memorySource: memory === null ? 'default' : 'device-memory',
    lowResource: limits.maxStorageBufferBindingSize < WEBLLM_FULL_STORAGE_BINDING,
  }
  if (
    limits.maxBufferSize < WEBLLM_MIN_BUFFER ||
    limits.maxStorageBufferBindingSize < WEBLLM_MIN_STORAGE_BINDING ||
    limits.maxComputeWorkgroupStorageSize < WEBLLM_MIN_WORKGROUP_STORAGE
  ) {
    return { supported: false, reason: 'too-little-memory', gpu }
  }
  return { supported: true, gpu }
}

/** A WebGPU stand-in for tests and e2e runs (browsers in CI have no usable GPU). */
export function fakeGpu(
  o: Partial<AdapterLike['limits']> & { shaderF16?: boolean; vendor?: string; adapter?: boolean } = {},
): GpuLike {
  return {
    requestAdapter: async () =>
      o.adapter === false
        ? null
        : {
            limits: {
              maxBufferSize: o.maxBufferSize ?? 4 * GiB,
              maxStorageBufferBindingSize: o.maxStorageBufferBindingSize ?? 4 * GiB,
              maxComputeWorkgroupStorageSize: o.maxComputeWorkgroupStorageSize ?? 32 * 1024,
            },
            features: { has: (name: string) => name === 'shader-f16' && o.shaderF16 !== false },
            info: { vendor: o.vendor ?? 'fake', architecture: '' },
          },
  }
}

// ---------------------------------------------------------------------------------------------
// Space

export interface StorageLike {
  estimate(): Promise<{ usage?: number; quota?: number }>
}

/** After a download, the origin keeps at least this much free for the library, or as much as it already uses. */
export const LIBRARY_RESERVE_MIN_BYTES = GiB
/** WebLLM also caches the model's WebGPU library, its tokenizer and config, beyond the weights llm-models sizes. */
export const NON_WEIGHT_ALLOWANCE_BYTES = 64 * MiB

export type SpaceVerdict =
  | {
      ok: true
      /** Bytes still to download. */
      needBytes: number
      /** Free space of the origin now. */
      freeBytes: number
      /** Space kept for the library after the download. */
      reserveBytes: number
    }
  | { ok: false; reason: 'unknown' }
  | { ok: false; reason: 'not-enough-space'; needBytes: number; freeBytes: number; reserveBytes: number }

/**
 * Whether a download fits without eating into the library: the library shares the origin's quota,
 * and a full quota would stop new changes from being saved. After the download, the free space must
 * still hold the library again (room to double) and never less than 1 GiB. Without an estimate,
 * nothing proves the space is there, so the answer is no.
 */
export function checkSpace(
  estimate: { usage?: number; quota?: number } | null,
  remainingBytes: number,
  cachedModelBytes: number,
): SpaceVerdict {
  if (!estimate || typeof estimate.usage !== 'number' || typeof estimate.quota !== 'number' || estimate.quota <= 0) {
    return { ok: false, reason: 'unknown' }
  }
  const freeBytes = Math.max(0, estimate.quota - estimate.usage)
  const library = Math.max(0, estimate.usage - cachedModelBytes)
  const reserveBytes = Math.max(LIBRARY_RESERVE_MIN_BYTES, library)
  const needBytes = Math.max(0, remainingBytes)
  if (freeBytes - needBytes < reserveBytes) {
    return { ok: false, reason: 'not-enough-space', needBytes, freeBytes, reserveBytes }
  }
  return { ok: true, needBytes, freeBytes, reserveBytes }
}

// ---------------------------------------------------------------------------------------------
// Weight cache

/** Every cache name Cursus creates starts with this: the origin is shared with other apps. */
export const CACHE_PREFIX = 'cursus-'
/** The Cache API scopes WebLLM writes to (hard-coded in @mlc-ai/web-llm); the worker prefixes them. */
export const WEBLLM_SCOPES = { model: 'webllm/model', config: 'webllm/config', wasm: 'webllm/wasm' } as const
export const cacheName = (scope: string): string => `${CACHE_PREFIX}${scope}`

export interface CacheLike {
  match(url: string): Promise<{ json(): Promise<unknown> } | undefined>
  keys(): Promise<readonly { readonly url: string }[]>
  put(url: string, response: Response): Promise<void>
  delete(url: string): Promise<boolean>
}
export interface CachesLike {
  open(name: string): Promise<CacheLike>
  has(name: string): Promise<boolean>
}

/**
 * A `CacheStorage` whose cache names carry `prefix`. Installed as the worker's `caches`, it makes
 * WebLLM's `webllm/*` caches `cursus-webllm/*`, away from other apps of the same origin.
 */
export interface NamedCaches<C extends { match(request: string): Promise<unknown> }> {
  open(name: string): Promise<C>
  has(name: string): Promise<boolean>
  delete(name: string): Promise<boolean>
  keys(): Promise<string[]>
}
export function prefixedCaches<C extends { match(request: string): Promise<unknown> }>(
  inner: NamedCaches<C>,
  prefix: string = CACHE_PREFIX,
): NamedCaches<C> & { match(request: string): Promise<unknown> } {
  const own = async () => (await inner.keys()).filter((n) => n.startsWith(prefix))
  return {
    open: (name) => inner.open(prefix + name),
    has: (name) => inner.has(prefix + name),
    delete: (name) => inner.delete(prefix + name),
    keys: async () => (await own()).map((n) => n.slice(prefix.length)),
    match: async (request) => {
      for (const name of await own()) {
        const hit = await (await inner.open(name)).match(request)
        if (hit) return hit
      }
      return undefined
    },
  }
}

/** Where WebLLM keeps one model: its weights' base URL and its WebGPU library's file name. */
export interface ModelFiles {
  /** Base URL of the weights, as WebLLM spells it (`…/resolve/main/`). */
  modelUrl: string
  /** File name of the compiled model library (the URL's directory varies with the WebLLM version). */
  libFile: string
}

/** WebLLM's `cleanModelUrl`: a Hugging Face repo URL becomes `<repo>/resolve/main/`. */
export function modelFiles(hfRepo: string, modelLib: string): ModelFiles {
  let url = hfRepo.endsWith('/') ? hfRepo : `${hfRepo}/`
  if (!/.+\/resolve\/.+\//.test(url)) url += 'resolve/main/'
  return { modelUrl: new URL(url).href, libFile: modelLib.slice(modelLib.lastIndexOf('/') + 1) }
}

export interface ModelCacheState {
  /** Weights, config, tokenizer and library all cached: the model runs offline. */
  complete: boolean
  /** Weight bytes already cached (a stopped download resumes from there). */
  cachedBytes: number
  /** Weight bytes in all, once WebLLM has fetched the shard list; null before. */
  totalBytes: number | null
}

interface Shard {
  dataPath: string
  nbytes: number
}
function shardsOf(json: unknown): Shard[] {
  const records = typeof json === 'object' && json !== null && 'records' in json ? json.records : undefined
  if (!Array.isArray(records)) throw new LocalModelError('engine', 'tensor-cache.json in the cache has no records')
  return records.map((r: unknown): Shard => {
    if (
      typeof r !== 'object' ||
      r === null ||
      !('dataPath' in r) ||
      typeof r.dataPath !== 'string' ||
      !('nbytes' in r) ||
      typeof r.nbytes !== 'number'
    ) {
      throw new LocalModelError('engine', 'tensor-cache.json in the cache has a malformed record')
    }
    return { dataPath: r.dataPath, nbytes: r.nbytes }
  })
}
function tokenizerFile(config: unknown): string | null {
  const files =
    typeof config === 'object' && config !== null && 'tokenizer_files' in config ? config.tokenizer_files : []
  if (!Array.isArray(files)) return null
  // WebLLM's asyncLoadTokenizer: tokenizer.json first, else tokenizer.model.
  if (files.includes('tokenizer.json')) return 'tokenizer.json'
  if (files.includes('tokenizer.model')) return 'tokenizer.model'
  return null
}

async function openIfPresent(caches: CachesLike, scope: string): Promise<CacheLike | null> {
  const name = cacheName(scope)
  return (await caches.has(name)) ? caches.open(name) : null
}

/** What of a model is cached, read the way WebLLM lays its caches out. */
export async function modelCacheState(caches: CachesLike, files: ModelFiles): Promise<ModelCacheState> {
  const empty: ModelCacheState = { complete: false, cachedBytes: 0, totalBytes: null }
  const model = await openIfPresent(caches, WEBLLM_SCOPES.model)
  if (!model) return empty
  const list = await model.match(new URL('tensor-cache.json', files.modelUrl).href)
  if (!list) return empty
  const shards = shardsOf(await list.json())
  const keys = new Set((await model.keys()).map((r) => r.url))
  let cachedBytes = 0
  let totalBytes = 0
  let allShards = true
  for (const s of shards) {
    totalBytes += s.nbytes
    if (keys.has(new URL(s.dataPath, files.modelUrl).href)) cachedBytes += s.nbytes
    else allShards = false
  }
  const config = await openIfPresent(caches, WEBLLM_SCOPES.config)
  const configHit = config ? await config.match(new URL('mlc-chat-config.json', files.modelUrl).href) : undefined
  const tokenizer = configHit ? tokenizerFile(await configHit.json()) : null
  const hasTokenizer = tokenizer !== null && keys.has(new URL(tokenizer, files.modelUrl).href)
  const wasm = await openIfPresent(caches, WEBLLM_SCOPES.wasm)
  const hasLib = wasm ? (await wasm.keys()).some((r) => r.url.endsWith(`/${files.libFile}`)) : false
  return { complete: allShards && hasTokenizer && hasLib, cachedBytes, totalBytes }
}

/** Deletes every cached file of a model; returns how many entries went. */
export async function removeModelFiles(caches: CachesLike, files: ModelFiles): Promise<number> {
  let removed = 0
  const drop = async (scope: string, mine: (url: string) => boolean) => {
    const cache = await openIfPresent(caches, scope)
    if (!cache) return
    for (const { url } of await cache.keys()) {
      if (mine(url) && (await cache.delete(url))) removed++
    }
  }
  await drop(WEBLLM_SCOPES.model, (url) => url.startsWith(files.modelUrl))
  await drop(WEBLLM_SCOPES.config, (url) => url.startsWith(files.modelUrl))
  await drop(WEBLLM_SCOPES.wasm, (url) => url.endsWith(`/${files.libFile}`))
  return removed
}

// ---------------------------------------------------------------------------------------------
// Engine seam

export interface LoadProgress {
  /** 0 to 1, download then upload to the GPU. */
  fraction: number
  /** The engine's own line, in English. */
  text: string
}

export interface LoadTarget {
  id: string
  files: ModelFiles
}

/**
 * What runs the model. The real one is WebLLM in a worker (`connectWorkerEngine`); tests and e2e
 * inject `fakeLocalEngine`. Loading a model downloads what the cache lacks, then puts it on the GPU.
 */
export interface LocalEngine {
  /** Ids of the models this engine can run. */
  models(): Promise<readonly string[]>
  /** Downloads (resuming) and loads; an abort stops it and keeps what was downloaded. */
  load(target: LoadTarget, onProgress: (p: LoadProgress) => void, signal?: AbortSignal): Promise<void>
  /** The loaded model as an AI SDK model; `providerOptions` are merged into every call. */
  languageModel(modelId: string, providerOptions?: SharedV4ProviderOptions): LanguageModelV4
  /** Frees the engine (the worker and its GPU memory). */
  dispose(): void
}

// ---------------------------------------------------------------------------------------------
// Worker protocol

type WireOptions = Omit<LanguageModelV4CallOptions, 'abortSignal'>
interface WireError {
  name: string
  message: string
  code?: LocalErrorCode
}

export type EngineRequest =
  | { id: number; op: 'models' }
  | { id: number; op: 'load'; modelId: string }
  | { id: number; op: 'generate'; modelId: string; options: WireOptions }
  | { id: number; op: 'stream'; modelId: string; options: WireOptions }
  | { id: number; op: 'abort'; target: number }

export type EngineResponse =
  | { id: number; kind: 'models'; ids: string[] }
  | { id: number; kind: 'progress'; progress: LoadProgress }
  | { id: number; kind: 'loaded' }
  | { id: number; kind: 'generated'; result: LanguageModelV4GenerateResult }
  | { id: number; kind: 'part'; part: LanguageModelV4StreamPart }
  | { id: number; kind: 'end' }
  | { id: number; kind: 'error'; error: WireError }

function toWire(e: unknown): WireError {
  if (e instanceof LocalModelError) return { name: e.name, message: e.message, code: e.code }
  if (e instanceof Error) return { name: e.name, message: e.message }
  if (typeof e === 'object' && e !== null && 'name' in e && 'message' in e) {
    return { name: String(e.name), message: String(e.message) }
  }
  return { name: 'Error', message: String(e) }
}
function fromWire(w: WireError): Error {
  if (w.code) return new LocalModelError(w.code, w.message)
  if (w.name === 'AbortError') return new DOMException(w.message, 'AbortError')
  const e = new Error(w.message)
  e.name = w.name
  return e
}

/** A message or error event, as both ends of the worker see it. */
export interface WorkerEvent {
  data?: unknown
  message?: string
}

const OPS: ReadonlySet<string> = new Set(['models', 'load', 'generate', 'stream', 'abort'])
const KINDS: ReadonlySet<string> = new Set(['models', 'progress', 'loaded', 'generated', 'part', 'end', 'error'])
/** The channel only carries our own messages; anything else (an extension's, a stray post) is ignored. */
function isRequest(d: unknown): d is EngineRequest {
  return (
    typeof d === 'object' && d !== null && 'id' in d && typeof d.id === 'number' && 'op' in d && OPS.has(String(d.op))
  )
}
function isResponse(d: unknown): d is EngineResponse {
  return (
    typeof d === 'object' &&
    d !== null &&
    'id' in d &&
    typeof d.id === 'number' &&
    'kind' in d &&
    KINDS.has(String(d.kind))
  )
}

/** The worker side, as the worker's global scope offers it. */
export interface WorkerScopeLike {
  postMessage(message: EngineResponse): void
  addEventListener(type: 'message', listener: (event: WorkerEvent) => void): void
}

/** What the worker runs: WebLLM through @browser-ai/web-llm (see src/workers/localModel.worker.ts). */
export interface EngineBackend {
  models(): readonly string[]
  load(modelId: string, onProgress: (p: LoadProgress) => void): Promise<void>
  model(modelId: string): LanguageModelV4
}

/** Answers the page's requests in the worker. */
export function serveLocalEngine(scope: WorkerScopeLike, backend: EngineBackend): void {
  const running = new Map<number, AbortController>()
  const send = (message: EngineResponse) => {
    try {
      scope.postMessage(message)
    } catch (e) {
      // A part the structured clone cannot copy: the request fails instead of hanging.
      scope.postMessage({ id: message.id, kind: 'error', error: toWire(e) })
    }
  }
  const handle = async (req: EngineRequest): Promise<void> => {
    switch (req.op) {
      case 'abort':
        running.get(req.target)?.abort()
        return
      case 'models':
        send({ id: req.id, kind: 'models', ids: [...backend.models()] })
        return
      case 'load':
        await backend.load(req.modelId, (progress) => send({ id: req.id, kind: 'progress', progress }))
        send({ id: req.id, kind: 'loaded' })
        return
      case 'generate': {
        const controller = new AbortController()
        running.set(req.id, controller)
        try {
          const result = await backend.model(req.modelId).doGenerate({ ...req.options, abortSignal: controller.signal })
          send({ id: req.id, kind: 'generated', result })
        } finally {
          running.delete(req.id)
        }
        return
      }
      case 'stream': {
        const controller = new AbortController()
        running.set(req.id, controller)
        try {
          const { stream } = await backend
            .model(req.modelId)
            .doStream({ ...req.options, abortSignal: controller.signal })
          const reader = stream.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            send({
              id: req.id,
              kind: 'part',
              part: value.type === 'error' ? { type: 'error', error: toWire(value.error) } : value,
            })
          }
          send({ id: req.id, kind: 'end' })
        } finally {
          running.delete(req.id)
        }
        return
      }
    }
  }
  scope.addEventListener('message', (event) => {
    const req = event.data
    if (!isRequest(req)) return
    handle(req).catch((e: unknown) => send({ id: req.id, kind: 'error', error: toWire(e) }))
  })
}

/** The page side of the worker: `new Worker(…)`, structurally. */
export interface WorkerLike {
  postMessage(message: EngineRequest): void
  addEventListener(type: 'message' | 'error', listener: (event: WorkerEvent) => void): void
  terminate(): void
}

/** A `LocalEngine` that runs in `worker` (which calls `serveLocalEngine`). */
export function connectWorkerEngine(worker: WorkerLike): LocalEngine {
  let next = 1
  let dead: Error | null = null
  const pending = new Map<number, (res: EngineResponse) => void>()
  const fail = (error: Error) => {
    dead = error
    for (const [id, on] of pending) on({ id, kind: 'error', error: toWire(error) })
    pending.clear()
  }
  worker.addEventListener('message', (event) => {
    const res = event.data
    if (isResponse(res)) pending.get(res.id)?.(res)
  })
  worker.addEventListener('error', (event) => fail(new LocalModelError('engine', event.message || 'the worker failed')))

  /** Sends a request; `on` gets every answer until it returns true (done). */
  const request = (make: (id: number) => EngineRequest, on: (res: EngineResponse) => boolean): number => {
    const id = next++
    if (dead) {
      on({ id, kind: 'error', error: toWire(dead) })
      return id
    }
    pending.set(id, (res) => {
      if (on(res)) pending.delete(id)
    })
    try {
      worker.postMessage(make(id))
    } catch (e) {
      // Options the structured clone cannot copy (a URL in the prompt): this call fails, the engine stays.
      pending.delete(id)
      on({ id, kind: 'error', error: toWire(e) })
    }
    return id
  }

  const dispose = () => {
    worker.terminate()
    fail(new LocalModelError('engine', 'the engine was stopped'))
  }

  return {
    models: () =>
      new Promise((resolve, reject) => {
        request(
          (id) => ({ id, op: 'models' }),
          (res) => {
            if (res.kind === 'models') resolve(res.ids)
            else if (res.kind === 'error') reject(fromWire(res.error))
            else return false
            return true
          },
        )
      }),
    load: (target, onProgress, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError(signal))
          return
        }
        // WebLLM cannot stop a download half-way: the worker goes, the shards it cached stay.
        const onAbort = () => {
          if (signal) reject(abortError(signal))
          dispose()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        request(
          (id) => ({ id, op: 'load', modelId: target.id }),
          (res) => {
            if (res.kind === 'progress') {
              onProgress(res.progress)
              return false
            }
            signal?.removeEventListener('abort', onAbort)
            if (res.kind === 'loaded') resolve()
            else if (res.kind === 'error') reject(fromWire(res.error))
            else return false
            return true
          },
        )
      }),
    languageModel: (modelId, providerOptions) => {
      const wire = (options: LanguageModelV4CallOptions): WireOptions => {
        const { abortSignal: _signal, ...rest } = options
        if (!providerOptions) return rest
        return { ...rest, providerOptions: { ...providerOptions, ...rest.providerOptions } }
      }
      const watch = (signal: AbortSignal | undefined, id: number, stop: () => void) => {
        if (!signal) return () => {}
        const onAbort = () => {
          worker.postMessage({ id: next++, op: 'abort', target: id })
          stop()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        return () => signal.removeEventListener('abort', onAbort)
      }
      return {
        specificationVersion: 'v4',
        provider: LOCAL_PROVIDER,
        modelId,
        supportedUrls: {},
        doGenerate: (options) =>
          new Promise<LanguageModelV4GenerateResult>((resolve, reject) => {
            const signal = options.abortSignal
            if (signal?.aborted) {
              reject(abortError(signal))
              return
            }
            let unwatch = () => {}
            const id = request(
              (rid) => ({ id: rid, op: 'generate', modelId, options: wire(options) }),
              (res) => {
                if (res.kind === 'generated') resolve(res.result)
                else if (res.kind === 'error') reject(fromWire(res.error))
                else return false
                unwatch()
                return true
              },
            )
            unwatch = watch(signal, id, () => {
              pending.delete(id)
              if (signal) reject(abortError(signal))
            })
          }),
        doStream: async (options) => {
          const signal = options.abortSignal
          if (signal?.aborted) throw abortError(signal)
          let unwatch = () => {}
          const stream = new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              const id = request(
                (rid) => ({ id: rid, op: 'stream', modelId, options: wire(options) }),
                (res) => {
                  if (res.kind === 'part') {
                    const part = res.part
                    controller.enqueue(
                      part.type === 'error' && typeof part.error === 'object' && part.error !== null
                        ? { type: 'error', error: fromWire(toWire(part.error)) }
                        : part,
                    )
                    return false
                  }
                  if (res.kind === 'end') controller.close()
                  else if (res.kind === 'error') controller.error(fromWire(res.error))
                  else return false
                  unwatch()
                  return true
                },
              )
              unwatch = watch(signal, id, () => {
                pending.delete(id)
                if (signal) controller.error(abortError(signal))
              })
            },
          })
          return { stream }
        },
      }
    },
    dispose,
  }
}

// ---------------------------------------------------------------------------------------------
// Fake engine

export interface FakeEngineOptions {
  /** Model ids the fake runs. */
  models: readonly string[]
  /** Where the "download" lands, in WebLLM's layout, so the cache checks see it. */
  caches?: CachesLike
  /** Weight shards per model (default 4), each declared `shardBytes` long (default 1 MiB). */
  shards?: number
  shardBytes?: number
  /** Awaited before each shard: lets a test or an e2e run hold or pace the download. */
  beforeShard?: (index: number) => Promise<void>
  /** The model's answer to a call; default: the smallest JSON the call's schema accepts. */
  respond?: (options: LanguageModelV4CallOptions) => string
}

export interface FakeEngine extends LocalEngine {
  /** Every call the fake model answered. */
  readonly calls: LanguageModelV4CallOptions[]
  /** Ids loaded by this engine instance. */
  readonly loaded: ReadonlySet<string>
  readonly disposed: boolean
}

/** A deterministic engine without weights or GPU, for unit tests and e2e runs. */
export function fakeLocalEngine(o: FakeEngineOptions): FakeEngine {
  const calls: LanguageModelV4CallOptions[] = []
  const loaded = new Set<string>()
  let disposed = false
  const shardCount = o.shards ?? 4
  const shardBytes = o.shardBytes ?? MiB

  const answer = (options: LanguageModelV4CallOptions): string => {
    if (o.respond) return o.respond(options)
    const format = options.responseFormat
    return format?.type === 'json' ? JSON.stringify(sampleJson(format.schema)) : 'ok'
  }
  const usage = (options: LanguageModelV4CallOptions, text: string) => {
    const input = Math.ceil(JSON.stringify(options.prompt).length / 4)
    const output = Math.ceil(text.length / 4)
    return {
      inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: output, text: output, reasoning: undefined },
    }
  }
  const ready = (modelId: string) => {
    if (disposed) throw new LocalModelError('engine', 'the engine was stopped')
    if (!loaded.has(modelId)) throw new LocalModelError('engine', `${modelId} is not loaded`)
  }

  return {
    calls,
    loaded,
    get disposed() {
      return disposed
    },
    models: async () => [...o.models],
    load: async (target, onProgress, signal) => {
      if (disposed) throw new LocalModelError('engine', 'the engine was stopped')
      if (!o.models.includes(target.id)) {
        throw new LocalModelError('unsupported-model', `${target.id} is not a model this engine runs`)
      }
      const caches = o.caches
      if (caches) {
        const model = await caches.open(cacheName(WEBLLM_SCOPES.model))
        const records = Array.from({ length: shardCount }, (_, i) => ({
          dataPath: `params_shard_${i}.bin`,
          nbytes: shardBytes,
        }))
        await model.put(
          new URL('tensor-cache.json', target.files.modelUrl).href,
          new Response(JSON.stringify({ records })),
        )
        const have = new Set((await model.keys()).map((r) => r.url))
        for (let i = 0; i < records.length; i++) {
          if (signal?.aborted) throw abortError(signal)
          const url = new URL(`params_shard_${i}.bin`, target.files.modelUrl).href
          if (!have.has(url)) {
            await o.beforeShard?.(i)
            if (signal?.aborted) throw abortError(signal)
            await model.put(url, new Response(new Uint8Array(8)))
          }
          onProgress({ fraction: (i + 1) / records.length, text: `Fetching param cache[${i + 1}/${records.length}]` })
        }
        const config = await caches.open(cacheName(WEBLLM_SCOPES.config))
        await config.put(
          new URL('mlc-chat-config.json', target.files.modelUrl).href,
          new Response(JSON.stringify({ tokenizer_files: ['tokenizer.json'] })),
        )
        await model.put(new URL('tokenizer.json', target.files.modelUrl).href, new Response('{}'))
        const wasm = await caches.open(cacheName(WEBLLM_SCOPES.wasm))
        await wasm.put(`https://fake.invalid/libs/${target.files.libFile}`, new Response(new Uint8Array(8)))
      } else {
        onProgress({ fraction: 1, text: 'Loaded' })
      }
      loaded.add(target.id)
    },
    languageModel: (modelId, providerOptions) => {
      const merged = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions =>
        providerOptions ? { ...options, providerOptions: { ...providerOptions, ...options.providerOptions } } : options
      return {
        specificationVersion: 'v4',
        provider: LOCAL_PROVIDER,
        modelId,
        supportedUrls: {},
        doGenerate: async (options) => {
          ready(modelId)
          const call = merged(options)
          calls.push(call)
          const text = answer(call)
          return {
            content: [{ type: 'text', text }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: usage(call, text),
            warnings: [],
          }
        },
        doStream: async (options) => {
          ready(modelId)
          const call = merged(options)
          calls.push(call)
          const text = answer(call)
          const third = Math.ceil(text.length / 3)
          const deltas = [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)].filter(Boolean)
          const parts: LanguageModelV4StreamPart[] = [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            ...deltas.map((delta): LanguageModelV4StreamPart => ({ type: 'text-delta', id: 't', delta })),
            { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(call, text) },
          ]
          return {
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(controller) {
                for (const p of parts) controller.enqueue(p)
                controller.close()
              },
            }),
          }
        },
      }
    },
    dispose: () => {
      disposed = true
      loaded.clear()
    },
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The smallest value a JSON schema (as the AI SDK sends it) accepts. */
export function sampleJson(schema: unknown, root: unknown = schema): unknown {
  if (!isRecord(schema)) return null
  const ref = schema.$ref
  if (typeof ref === 'string' && isRecord(root)) {
    const [, bag, name] = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref) ?? []
    const defs = bag ? root[bag] : undefined
    return sampleJson(isRecord(defs) && name ? defs[name] : undefined, root)
  }
  if ('const' in schema) return schema.const
  if (Array.isArray(schema.enum)) return schema.enum[0] ?? null
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const options = schema[key]
    if (Array.isArray(options) && options.length > 0) return sampleJson(options[0], root)
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const type = types.find((t) => t !== 'null') ?? types[0]
  switch (type) {
    case 'object': {
      const props = isRecord(schema.properties) ? schema.properties : {}
      const required = Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === 'string') : []
      const out: Record<string, unknown> = {}
      for (const key of required) out[key] = sampleJson(props[key], root)
      return out
    }
    case 'array': {
      const min = typeof schema.minItems === 'number' ? schema.minItems : 0
      const item = Array.isArray(schema.items) ? schema.items[0] : schema.items
      return Array.from({ length: min }, () => sampleJson(item, root))
    }
    case 'string':
      return 'x'.repeat(typeof schema.minLength === 'number' ? Math.max(1, schema.minLength) : 1)
    case 'number':
    case 'integer':
      return typeof schema.minimum === 'number' ? schema.minimum : 0
    case 'boolean':
      return false
    default:
      return null
  }
}
