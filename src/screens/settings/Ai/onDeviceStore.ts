/// <reference types="vite/client" />
/**
 * State of the "On this device" card, outside React: a download outlives the screen (leave the
 * settings, come back, and it is still running). The service and llm-models load on first use.
 */

import type { BrowserModel } from 'llm-models/browser'
import { useSyncExternalStore } from 'react'
import {
  cacheName,
  type GpuReport,
  LocalModelError,
  type LocalUnsupportedReason,
  type ModelCacheState,
  type SpaceVerdict,
  WEBLLM_SCOPES,
} from '../../../core/ai/local'
import type { LocalChoice, LocalModels } from '../../../core/ai/localModels'
// The URL of the engine's worker script (the same file core starts), not its code.
import engineScript from '../../../workers/localModel.worker.ts?worker&url'

export type DeviceState =
  | { kind: 'checking' }
  | { kind: 'unsupported'; reason: LocalUnsupportedReason; gpu?: GpuReport }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; gpu: GpuReport; choice: LocalChoice }

export type Outcome =
  | { kind: 'cancelled' }
  | { kind: 'no-space'; space: SpaceVerdict }
  | { kind: 'failed'; message: string }
  | { kind: 'removed' }
  | { kind: 'downloaded' }

export interface ModelState {
  /** What of the model is cached; null until read. */
  cache: ModelCacheState | null
  /** Whether what remains to download fits; null when complete or not read yet. */
  space: SpaceVerdict | null
  /** Weight bytes to download in all (WebLLM's shard list, else llm-models' figure). */
  downloadBytes: number | null
  /** 0 to 1 while downloading. */
  progress: number | null
  /** What the last action led to, for the status line. */
  outcome: Outcome | null
}

export interface OnDeviceSnapshot {
  /** The service, once its module has loaded. */
  service: LocalModels | null
  device: DeviceState
  models: Readonly<Record<string, ModelState>>
  /** Id of the model being downloaded. */
  downloading: string | null
}

const EMPTY_MODEL: ModelState = { cache: null, space: null, downloadBytes: null, progress: null, outcome: null }

let snapshot: OnDeviceSnapshot = { service: null, device: { kind: 'checking' }, models: {}, downloading: null }
const listeners = new Set<() => void>()
let checking: Promise<void> | null = null
let controller: AbortController | null = null

function publish(next: Partial<OnDeviceSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const l of listeners) l()
}
function patchModel(id: string, patch: Partial<ModelState>): void {
  const before = snapshot.models[id] ?? EMPTY_MODEL
  publish({ models: { ...snapshot.models, [id]: { ...before, ...patch } } })
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

let servicePromise: Promise<LocalModels> | null = null
function service(): Promise<LocalModels> {
  servicePromise ??= import('../../../core/ai/localModels').then((m) => {
    const s = m.localModels()
    publish({ service: s })
    return s
  })
  return servicePromise
}

/** Detects the device and ranks the models once per page (again after `recheck`). */
export function checkDevice(): Promise<void> {
  checking ??= (async () => {
    try {
      const s = await service()
      const r = await s.recommend()
      publish({
        device: r.supported
          ? { kind: 'ready', gpu: r.gpu, choice: r.choice }
          : r.gpu
            ? { kind: 'unsupported', reason: r.reason, gpu: r.gpu }
            : { kind: 'unsupported', reason: r.reason },
      })
    } catch (e) {
      publish({ device: { kind: 'failed', message: message(e) } })
    }
  })()
  return checking
}

/** Id of the model picked for this device, once the check is done. */
export function pickedLocalModel(): string | undefined {
  return snapshot.device.kind === 'ready' ? snapshot.device.choice.model.id : undefined
}

export function recheck(): Promise<void> {
  checking = null
  publish({ device: { kind: 'checking' } })
  return checkDevice()
}

/** The service worker serves the engine's script from this cache (its runtime route in vite.config.ts). */
const ENGINE_CACHE = 'cursus-local-engine'

/**
 * Keeps the engine's script for offline use, once a model is downloaded. The service worker stores it
 * when it serves it, but a script first loaded before the page was controlled (the first visit) never
 * reaches it, and WebKit keeps serving that copy from memory. Stored here, the service worker finds it
 * offline. Only the current version stays.
 */
async function keepEngineOffline(): Promise<void> {
  const url = new URL(engineScript, location.href).href
  const cache = await caches.open(ENGINE_CACHE)
  for (const request of await cache.keys()) if (request.url !== url) await cache.delete(request)
  if (!(await cache.match(url))) await cache.add(url)
}

const hasModelFiles = async (): Promise<boolean> => {
  const models = cacheName(WEBLLM_SCOPES.model)
  return (await caches.has(models)) && (await (await caches.open(models)).keys()).length > 0
}

/**
 * Run at startup, in idle time. An update gives the engine's script a new URL, which the service worker
 * stores only when the engine next runs online: offline before that, a downloaded model would have no
 * engine. With a model on the device and a connection, the current script is stored now and the older
 * ones dropped. Nothing happens without a model: the engine is not fetched for nothing.
 */
export async function keepEngineFresh(): Promise<void> {
  if (!navigator.onLine || typeof caches === 'undefined') return
  if (await hasModelFiles()) await keepEngineOffline()
}

/** Drops the engine's script once no model is left to run (the service worker stores it again on use). */
async function dropEngineIfUnused(): Promise<void> {
  if (!(await hasModelFiles())) await caches.delete(ENGINE_CACHE)
}

/** Reads what of `model` is cached and whether the rest fits; a downloaded model's engine is kept offline. */
export async function refreshModel(model: BrowserModel): Promise<void> {
  try {
    const s = await service()
    const handle = s.handle(model)
    const cache = await handle.state()
    // Offline there is nothing to fetch: the script is either already kept or cannot be until online.
    if (cache.complete && navigator.onLine) await keepEngineOffline()
    const space = cache.complete ? null : await handle.checkSpace()
    patchModel(model.id, { cache, space, downloadBytes: cache.totalBytes ?? handle.downloadBytes })
  } catch (e) {
    patchModel(model.id, { outcome: { kind: 'failed', message: message(e) } })
  }
}

/** Downloads `model` (what the cache lacks), reporting progress; `cancelDownload` stops it. */
export async function downloadModel(model: BrowserModel): Promise<void> {
  if (snapshot.downloading) return
  const own = new AbortController()
  controller = own
  publish({ downloading: model.id })
  patchModel(model.id, { progress: 0, outcome: null })
  let percent = 0
  try {
    const s = await service()
    await s.handle(model).download((p) => {
      // The engine reports many times a second: the screen moves by whole percents.
      const next = Math.floor(Math.min(1, Math.max(0, p.fraction)) * 100)
      if (next === percent) return
      percent = next
      patchModel(model.id, { progress: next / 100 })
    }, own.signal)
    patchModel(model.id, { outcome: { kind: 'downloaded' } })
  } catch (e) {
    if (own.signal.aborted) patchModel(model.id, { outcome: { kind: 'cancelled' } })
    else if (e instanceof LocalModelError && e.code === 'no-space' && e.space) {
      patchModel(model.id, { outcome: { kind: 'no-space', space: e.space } })
    } else patchModel(model.id, { outcome: { kind: 'failed', message: message(e) } })
  }
  try {
    // After a failure too: what was cached before it stays, and a new attempt resumes from there. Read
    // before the download is over, so the screen goes from the progress bar straight to the outcome.
    await refreshModel(model)
  } finally {
    if (controller === own) controller = null
    publish({ downloading: null })
    patchModel(model.id, { progress: null })
  }
}

export function cancelDownload(): void {
  controller?.abort()
}

/** Deletes the model's files (a stopped download's too). */
export async function removeModel(model: BrowserModel): Promise<void> {
  try {
    const s = await service()
    await s.handle(model).remove()
    await dropEngineIfUnused()
    patchModel(model.id, { outcome: { kind: 'removed' } })
  } catch (e) {
    patchModel(model.id, { outcome: { kind: 'failed', message: message(e) } })
  }
  await refreshModel(model)
}

/** Frees the engine (its worker and GPU memory) unless a download needs it; the next use starts it again. */
export function releaseEngine(): void {
  if (!snapshot.downloading) snapshot.service?.release()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useOnDevice(): OnDeviceSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

export const modelState = (s: OnDeviceSnapshot, id: string): ModelState => s.models[id] ?? EMPTY_MODEL
