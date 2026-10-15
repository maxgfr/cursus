import { guardChunk, type PageEnv, type Report } from './chunkGuard.ts'

export interface EngineFreshDeps {
  /** Loads the on-device model store (a deferred chunk). */
  load: () => Promise<{ keepEngineFresh(): Promise<void> }>
  /** The page is about to reload into a new version, which keeps the engine fresh itself. */
  reloading: () => boolean
  /** Records a failed load for the diagnostic report. */
  report: Report
  /** Says the engine was not kept: the load or the storing failed. */
  fail: (e: unknown) => void
  env?: PageEnv
}

/**
 * After an update, a downloaded model's new engine script is stored before going offline needs it. Not started
 * while an update reloads the page; a load the reload aborts is the reload itself, not a failure (the chunk
 * guard drops it), while any other failure is recorded and said.
 */
export function keepEngineFresh({ load, reloading, report, fail, env }: EngineFreshDeps): Promise<void> {
  if (reloading()) return Promise.resolve()
  return guardChunk(load, 'chunk.onDeviceStore', report, env)
    .then((m) => m.keepEngineFresh())
    .catch(fail)
}
