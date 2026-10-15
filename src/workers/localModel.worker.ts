/**
 * Runs the "On this device" model: WebLLM, through @browser-ai/web-llm's AI SDK model, off the main
 * thread. The page talks to it with `connectWorkerEngine` (src/core/ai/local.ts). This file is the
 * only place WebLLM is imported, so it never reaches the page's bundle.
 */
import { WebLLMLanguageModel } from '@browser-ai/web-llm'
import { ModelType, prebuiltAppConfig } from '@mlc-ai/web-llm'
import { type LoadProgress, LocalModelError, prefixedCaches, serveLocalEngine } from '../core/ai/local'

// WebLLM names its caches `webllm/*`; on an origin shared with other apps they become `cursus-webllm/*`.
// WebLLM opens them lazily, so replacing `caches` here, before any request, covers every access.
Object.defineProperty(globalThis, 'caches', { value: prefixedCaches(globalThis.caches), configurable: true })

/** The models of the installed WebLLM, with the library builds its runtime matches. */
const runnable = new Map(
  prebuiltAppConfig.model_list
    .filter((m) => (m.model_type ?? ModelType.LLM) === ModelType.LLM)
    .map((m) => [m.model_id, m] as const),
)

let current: { id: string; model: WebLLMLanguageModel } | null = null
/** Where WebLLM's progress goes: the load request being served. */
let report: (p: LoadProgress) => void = () => {}

serveLocalEngine(self, {
  models: () => [...runnable.keys()],
  async load(modelId: string, onProgress: (p: LoadProgress) => void) {
    if (!runnable.has(modelId)) throw new LocalModelError('unsupported-model', `${modelId} is not in WebLLM's list`)
    if (current?.id !== modelId) {
      // One model at a time: the page restarts the worker to switch, so this only replaces a failed load.
      current = {
        id: modelId,
        model: new WebLLMLanguageModel(modelId, {
          appConfig: prebuiltAppConfig,
          initProgressCallback: (p) => report({ fraction: p.progress, text: p.text }),
        }),
      }
    }
    report = onProgress
    try {
      await current.model.createSessionWithProgress()
    } finally {
      report = () => {}
    }
  },
  model(modelId: string) {
    if (current?.id !== modelId || !current.model.isModelInitialized) {
      throw new LocalModelError('engine', `${modelId} is not loaded`)
    }
    return current.model
  },
})
