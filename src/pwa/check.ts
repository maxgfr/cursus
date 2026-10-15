import { pendingUpdate, pwaRegistration, subscribeUpdate } from './index.ts'

/**
 * What a check for a new version found: one `available` (installed and waiting: `pendingUpdate()` applies
 * it), `none`, `offline` (nothing could be asked), or `unsupported` (no service worker here: dev, private
 * browsing, blocked).
 */
export type UpdateCheck = 'available' | 'none' | 'offline' | 'unsupported'

/** Thrown when a new version was found but could not be downloaded (the next check tries again). */
export class UpdateDownloadError extends Error {
  constructor() {
    super('The new version could not be installed')
    this.name = 'UpdateDownloadError'
  }
}

/**
 * Asks the server for a new version now and, when there is one, waits until it is downloaded and waiting:
 * the same worker the foreground check finds and the update toast offers. Rejects on a network failure
 * while online, and with `UpdateDownloadError` when the new version failed to install.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (pendingUpdate()) return 'available'
  const reg = await pwaRegistration()
  if (!reg) return 'unsupported'
  if (!navigator.onLine) return 'offline'
  try {
    await reg.update()
  } catch (e) {
    if (!navigator.onLine) return 'offline'
    throw e
  }
  const worker = reg.installing ?? reg.waiting
  if (!worker) return pendingUpdate() ? 'available' : 'none'
  const settled = await untilSettled(worker)
  if (settled === 'waiting') return 'available'
  if (settled === 'current') return 'none'
  if (!navigator.onLine) return 'offline'
  throw new UpdateDownloadError()
}

/**
 * A new worker is `waiting` once the update toast's source has it, `current` when it took control at once (the
 * first install: it runs this very build), or `failed` (redundant: its install failed).
 */
function untilSettled(worker: ServiceWorker): Promise<'waiting' | 'current' | 'failed'> {
  return new Promise((resolve) => {
    const done = (outcome: 'waiting' | 'current' | 'failed') => {
      unsubscribe()
      worker.removeEventListener('statechange', changed)
      resolve(outcome)
    }
    const changed = () => {
      if (pendingUpdate()) done('waiting')
      else if (worker.state === 'activating' || worker.state === 'activated') done('current')
      else if (worker.state === 'redundant') done('failed')
    }
    const unsubscribe = subscribeUpdate(changed)
    worker.addEventListener('statechange', changed)
    changed()
  })
}
