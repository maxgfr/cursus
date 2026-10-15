/**
 * The "On this device" service: picks the model with llm-models, downloads it into the cache after a
 * space check, runs it in the engine and hands the features an AI SDK model. Load this module lazily:
 * it carries llm-models' browser-model catalog.
 */
import type { LanguageModelV4, SharedV4ProviderOptions } from '@ai-sdk/provider'
import {
  type BrowserModel,
  type BrowserModelNeed,
  browserModelCatalog,
  listBrowserModels,
  recommendBrowserModel,
} from 'llm-models/browser'
import type { CatalogModel } from './catalogTrim'
// The installed WebLLM's model ids, extracted at build time (scripts/build-engine-models.ts): ranking
// models needs no engine, so opening the settings never fetches it.
import { ENGINE_MODELS } from './engineModels'
import {
  type CachesLike,
  checkSpace,
  connectWorkerEngine,
  type DetectEnv,
  detectLocalSupport,
  type GpuReport,
  LOCAL_PROVIDER,
  type LoadProgress,
  type LocalDetection,
  type LocalEngine,
  LocalModelError,
  type LocalUnsupportedReason,
  type ModelCacheState,
  type ModelFiles,
  modelCacheState,
  modelFiles,
  NON_WEIGHT_ALLOWANCE_BYTES,
  removeModelFiles,
  type SpaceVerdict,
  type StorageLike,
} from './local'

/** Every feature asks for structured output, in the course's language (English, German, French…). */
export const LOCAL_NEEDS: readonly BrowserModelNeed[] = ['json', 'multilingual']

export interface LocalChoice {
  model: BrowserModel
  /** Runner-ups that also fit, best first. */
  alternatives: readonly BrowserModel[]
  /** llm-models' explanation of the pick, in English. */
  reason: string
  /** GPU memory the model needs (WebLLM's figure). */
  memoryMB: number
  /** Bytes of weights to download (WebLLM's shard list); null when not published. */
  downloadBytes: number | null
}

export type LocalRecommendation =
  | { supported: true; gpu: GpuReport; choice: LocalChoice }
  | { supported: false; reason: LocalUnsupportedReason; gpu?: GpuReport }

/** Weight bytes of a model, from the WebLLM shard list llm-models read (`download_mb` is rounded). */
export function downloadBytesOf(model: BrowserModel): number | null {
  const record = browserModelCatalog().models.find((r) => r.model_id === model.id)
  return record?.weights_bytes ?? (model.download_mb === null ? null : Math.round(model.download_mb * 1e6))
}

/** The default model, in whichever build (fp16 or fp32) the device runs. */
export const DEFAULT_LOCAL_SERIES = 'gemma-4'
export const DEFAULT_LOCAL_PARAMS_B = 2

const isDefaultLocal = (m: BrowserModel) => m.series === DEFAULT_LOCAL_SERIES && m.params_b === DEFAULT_LOCAL_PARAMS_B

/**
 * The model this device should run: Gemma 4 E2B when the device fits it, otherwise the best one
 * llm-models ranks among the models the engine knows (its catalog may list builds newer than the
 * installed WebLLM), against the GPU memory budget, the adapter's fp16 support and its storage-buffer
 * limit. Nothing fitting means too little memory.
 */
export function recommendLocal(
  detection: LocalDetection,
  engineIds: ReadonlySet<string>,
  models: readonly BrowserModel[] = listBrowserModels(),
): LocalRecommendation {
  if (!detection.supported) return detection
  const { gpu } = detection
  const runnable = models.filter((m) => engineIds.has(m.id))
  const options = {
    vram_budget_mb: gpu.memoryBudgetMB,
    needs: [...LOCAL_NEEDS],
    shader_f16: gpu.shaderF16,
    low_resource: gpu.lowResource,
  }
  const ranked = recommendBrowserModel(options, runnable)
  if (!ranked) return { supported: false, reason: 'too-little-memory', gpu }
  const preferred = recommendBrowserModel(options, runnable.filter(isDefaultLocal))
  const pick = preferred
    ? {
        model: preferred.model,
        alternatives: [ranked.model, ...ranked.alternatives].filter((m) => !isDefaultLocal(m)),
        reason: preferred.reason,
      }
    : ranked
  return {
    supported: true,
    gpu,
    choice: {
      model: pick.model,
      alternatives: pick.alternatives,
      reason: pick.reason,
      memoryMB: pick.model.vram_required_mb,
      downloadBytes: downloadBytesOf(pick.model),
    },
  }
}

export function findLocalModel(modelId: string, models: readonly BrowserModel[] = listBrowserModels()) {
  return models.find((m) => m.id === modelId)
}

/** The model as the features and the usage log see it: free, since it runs here. */
export function localModelInfo(model: BrowserModel): CatalogModel {
  const info: CatalogModel = {
    id: model.id,
    name: `${model.series}${model.params_b === null ? '' : ` ${model.params_b}B`}`,
    provider: LOCAL_PROVIDER,
    context_length: model.context_window ?? 4096,
    cost: { input: 0, output: 0 },
    modalities: { input: ['text'] },
    capabilities: { structured_output: model.structured_output },
  }
  if (model.reasoning) info.capabilities.reasoning = true
  if (model.released) info.release_date = model.released
  return info
}

/**
 * Hybrid models (Qwen3, Qwen3.5) think unless told not to; thinking spends the small context and
 * the user's time. WebLLM's `enable_thinking: false` is understood by those models only.
 */
export function callDefaults(model: BrowserModel): SharedV4ProviderOptions | undefined {
  return model.reasoning && model.variant === 'chat'
    ? { 'web-llm': { extra_body: { enable_thinking: false } } }
    : undefined
}

export interface DownloadProgress extends LoadProgress {}

/** One model, as the settings card drives it. */
export interface LocalModelHandle {
  readonly model: BrowserModel
  readonly files: ModelFiles
  readonly downloadBytes: number | null
  isDownloaded(): Promise<boolean>
  state(): Promise<ModelCacheState>
  /** Whether the download fits next to the library (what remains, if one was stopped). */
  checkSpace(): Promise<SpaceVerdict>
  /**
   * Downloads what the cache lacks, then loads the model. Refuses with `LocalModelError('no-space')`
   * when the space check fails. An abort stops it; calling it again resumes.
   */
  download(onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void>
  /** Deletes the model's files and frees the engine if it held this model. */
  remove(): Promise<void>
}

export interface LocalModels {
  detect(): Promise<LocalDetection>
  /** Detection, then the best model among those the engine runs (no engine starts: the ids are known). */
  recommend(): Promise<LocalRecommendation>
  find(modelId: string): BrowserModel | undefined
  info(modelId: string): CatalogModel | undefined
  handle(model: BrowserModel): LocalModelHandle
  /** An AI SDK model for a downloaded model; refuses with `LocalModelError('not-downloaded')`. */
  languageModel(modelId: string): Promise<LanguageModelV4>
  /** Frees the engine and the GPU memory it holds; the next call starts it again. */
  release(): void
}

export interface LocalModelsDeps {
  env: () => DetectEnv
  /** Makes an engine, only to download or run a model; called again after the previous one was disposed. */
  engine: () => LocalEngine
  /** Ids of the models the engine runs; by default the installed WebLLM's, read at build time. */
  engineModels?: readonly string[]
  storage?: StorageLike | undefined
  caches?: CachesLike | undefined
  models?: readonly BrowserModel[]
}

export function createLocalModels(deps: LocalModelsDeps): LocalModels {
  const models = deps.models ?? listBrowserModels()
  const engineIds: ReadonlySet<string> = new Set(deps.engineModels ?? ENGINE_MODELS)
  let engine: LocalEngine | null = null
  /** The model the engine holds, or is loading. */
  let current: { id: string; ready: Promise<void> } | null = null

  const getEngine = () => {
    engine ??= deps.engine()
    return engine
  }
  const drop = () => {
    engine?.dispose()
    engine = null
    current = null
  }
  const caches = () => {
    if (!deps.caches) throw new LocalModelError('engine', 'this browser has no Cache Storage')
    return deps.caches
  }
  const filesOf = (model: BrowserModel) => modelFiles(model.hf_repo, model.model_lib)

  /** Loads `model` into the engine (one model at a time: another one frees the engine first). */
  const ensureLoaded = (model: BrowserModel, onProgress: (p: LoadProgress) => void, signal?: AbortSignal) => {
    if (current?.id === model.id) return current.ready
    if (current) drop()
    const ready = getEngine()
      .load({ id: model.id, files: filesOf(model) }, onProgress, signal)
      .catch((e: unknown) => {
        // Whatever state the engine is in now is unknown: start afresh next time.
        if (current?.ready === ready) drop()
        throw e
      })
    current = { id: model.id, ready }
    return ready
  }

  const handle = (model: BrowserModel): LocalModelHandle => {
    const files = filesOf(model)
    const downloadBytes = downloadBytesOf(model)
    const state = () => modelCacheState(caches(), files)
    const space = async (s: ModelCacheState) => {
      const total = s.totalBytes ?? downloadBytes
      if (total === null) return checkSpace(null, 0, 0)
      const remaining = s.complete ? 0 : total - s.cachedBytes + NON_WEIGHT_ALLOWANCE_BYTES
      return checkSpace(deps.storage ? await deps.storage.estimate() : null, remaining, s.cachedBytes)
    }
    return {
      model,
      files,
      downloadBytes,
      isDownloaded: async () => (await state()).complete,
      state,
      checkSpace: async () => space(await state()),
      download: async (onProgress = () => {}, signal) => {
        const before = await state()
        if (before.complete) {
          onProgress({ fraction: 1, text: 'Already downloaded' })
          return
        }
        const verdict = await space(before)
        if (!verdict.ok) {
          throw new LocalModelError(
            'no-space',
            verdict.reason === 'unknown'
              ? 'the browser does not tell how much space is free'
              : 'the download would eat into the space the library needs',
            verdict,
          )
        }
        await ensureLoaded(model, onProgress, signal)
        if (!(await state()).complete) {
          throw new LocalModelError('engine', `${model.id} loaded but its files are not all in the cache`)
        }
      },
      remove: async () => {
        if (current?.id === model.id) drop()
        await removeModelFiles(caches(), files)
      },
    }
  }

  return {
    detect: () => detectLocalSupport(deps.env()),
    recommend: async () => {
      const detection = await detectLocalSupport(deps.env())
      if (!detection.supported) return detection
      return recommendLocal(detection, engineIds, models)
    },
    find: (modelId) => findLocalModel(modelId, models),
    info: (modelId) => {
      const model = findLocalModel(modelId, models)
      return model ? localModelInfo(model) : undefined
    },
    handle,
    languageModel: async (modelId) => {
      const model = findLocalModel(modelId, models)
      if (!model) throw new LocalModelError('unsupported-model', `${modelId} is not a WebLLM model`)
      if (!(await handle(model).isDownloaded())) {
        throw new LocalModelError('not-downloaded', `${modelId} is not downloaded on this device`)
      }
      const defaults = callDefaults(model)
      // Loaded on first use, from the cache: nothing is fetched, nothing is sent.
      const ready = () => ensureLoaded(model, () => {})
      return {
        specificationVersion: 'v4',
        provider: LOCAL_PROVIDER,
        modelId,
        supportedUrls: {},
        doGenerate: async (options) => {
          await ready()
          return getEngine().languageModel(modelId, defaults).doGenerate(options)
        },
        doStream: async (options) => {
          await ready()
          return getEngine().languageModel(modelId, defaults).doStream(options)
        },
      }
    },
    release: drop,
  }
}

/** The worker the real engine runs in; WebLLM is bundled into it, never into the page. */
function workerEngine(): LocalEngine {
  return connectWorkerEngine(
    new Worker(new URL('../../workers/localModel.worker.ts', import.meta.url), {
      type: 'module',
      name: 'cursus-local-model',
    }),
  )
}

interface BrowserGlobals {
  navigator?: { gpu?: DetectEnv['gpu']; deviceMemory?: number; storage?: StorageLike }
  caches?: CachesLike
}

function browserDeps(): LocalModelsDeps {
  const g: BrowserGlobals = globalThis
  return {
    env: () => ({ gpu: g.navigator?.gpu, deviceMemory: g.navigator?.deviceMemory }),
    engine: workerEngine,
    storage: g.navigator?.storage,
    caches: g.caches,
  }
}

let overrides: Partial<LocalModelsDeps> = {}
let instance: LocalModels | null = null

/** The app's service: the browser's GPU, storage and caches, the engine in a worker. */
export function localModels(): LocalModels {
  instance ??= createLocalModels({ ...browserDeps(), ...overrides })
  return instance
}

/**
 * Replaces parts of the app's service (e2e: a fake GPU and `fakeLocalEngine`, no weights). Null
 * restores the browser's. The next `localModels()` call builds the service again.
 */
export function configureLocalModels(next: Partial<LocalModelsDeps> | null): void {
  instance?.release()
  overrides = next ?? {}
  instance = null
}
