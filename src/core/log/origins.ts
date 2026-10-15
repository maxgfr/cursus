import * as Y from 'yjs'

/** Transaction origins that must NOT be captured into `pending`: they already exist in the log. */
export const REMOTE = Symbol('cursus:remote') // applied from a destination
export const TAB = Symbol('cursus:tab') // relayed from another tab via since()
export const REPLAY = Symbol('cursus:replay') // load / replay of the persisted log

const IGNORED: ReadonlySet<unknown> = new Set([REMOTE, TAB, REPLAY])

/** Everything else is captured, including UndoManager origins: undo/redo are local edits. */
export function shouldCapture(origin: unknown): boolean {
  return !IGNORED.has(origin)
}

/** The capture was stopped while updates were still unacknowledged: they were never saved. */
export class CaptureStoppedError extends Error {
  constructor(
    readonly unsaved: number,
    cause?: unknown,
  ) {
    super(`Capture stopped with ${unsaved} unsaved update(s)`, cause === undefined ? undefined : { cause })
    this.name = 'CaptureStoppedError'
  }
}

export interface CaptureOptions {
  /** Every failed append (e.g. LocalQuotaError), with the update that is kept in memory and retried. */
  onError?: (e: unknown, update: Uint8Array) => void
  /** The acknowledgment of each captured update: resolves once it is durably appended. */
  onQueued?: (ack: Promise<void>) => void
  /** The unsaved count or the blocked state changed (refresh the status, show the banner). */
  onChange?: () => void
  /** Backoff before retry number `attempt` (1, 2, …). */
  retryDelayMs?: (attempt: number) => number
  /** Timer used for the backoff; returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void
}

export interface Capture {
  /** Same as `stop()`. */
  (): void
  /** Stops capturing; updates still unacknowledged are reported lost (their acks reject). */
  stop(): void
  /** Updates captured but not yet acknowledged by the log (in flight, failed or queued behind). */
  unsaved(): number
  /** An append failed and is waiting for its retry: "not saved on this device". */
  blocked(): boolean
  /** Retries now, without waiting for the backoff; resolves like `settled()`. */
  retry(): Promise<void>
  /** Resolves once nothing is being appended: the queue is empty, or blocked on a failure. */
  settled(): Promise<void>
}

export const RETRY_MAX_MS = 60_000
const defaultDelay = (attempt: number): number => Math.min(RETRY_MAX_MS, 1000 * 2 ** (attempt - 1))
const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

interface Queued {
  update: Uint8Array
  resolve?: () => void
  reject?: (e: unknown) => void
}

/**
 * Captures every local V2 update into the log through ONE ordered queue: an update is appended only
 * after every earlier one was acknowledged, so a later update is never persisted without its
 * predecessor. Updates queued behind an append are merged and written together by the next one. A failed append keeps that update and all later ones in memory, retries with backoff,
 * and reports `blocked()` / `unsaved()` until the log has acknowledged everything.
 */
export function captureUpdates(
  doc: Y.Doc,
  append: (update: Uint8Array) => Promise<void>,
  options: CaptureOptions | ((e: unknown, update: Uint8Array) => void) = {},
): Capture {
  const o: CaptureOptions = typeof options === 'function' ? { onError: options } : options
  const delay = o.retryDelayMs ?? defaultDelay
  const setTimer = o.setTimer ?? defaultTimer
  const queue: Queued[] = []
  let running = false
  let inFlight = 0
  let stopped = false
  let isBlocked = false
  let attempt = 0
  let lastError: unknown
  let cancelTimer: (() => void) | null = null
  let waiters: (() => void)[] = []

  const changed = (): void => o.onChange?.()
  const wake = (): void => {
    const ws = waiters
    waiters = []
    for (const w of ws) w()
  }

  const pump = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      while (queue.length > 0 && !stopped) {
        // Everything waiting is merged into ONE append: a fast typist's backlog stays one write behind,
        // instead of one write per keystroke that an unload would cut short.
        const batch = queue.slice()
        const update = batch.length === 1 ? (batch[0] as Queued).update : Y.mergeUpdatesV2(batch.map((q) => q.update))
        inFlight = batch.length
        try {
          await append(update)
        } catch (e) {
          attempt++
          lastError = e
          isBlocked = true
          o.onError?.(e, update)
          changed()
          if (stopped) for (const item of batch) item.reject?.(new CaptureStoppedError(queue.length, e))
          else {
            cancelTimer = setTimer(() => {
              cancelTimer = null
              void pump()
            }, delay(attempt))
          }
          return
        } finally {
          inFlight = 0
        }
        queue.splice(0, batch.length)
        attempt = 0
        isBlocked = false
        for (const item of batch) item.resolve?.()
        changed()
      }
    } finally {
      running = false
      wake()
    }
  }

  const handler = (update: Uint8Array, origin: unknown): void => {
    if (stopped || !shouldCapture(origin)) return
    const item: Queued = { update }
    if (o.onQueued) {
      o.onQueued(
        new Promise<void>((resolve, reject) => {
          item.resolve = resolve
          item.reject = reject
        }),
      )
    }
    queue.push(item)
    changed()
    // While blocked, the update waits behind the failed one until the scheduled retry.
    if (cancelTimer === null) void pump()
  }
  doc.on('updateV2', handler)

  const settled = (): Promise<void> =>
    running ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve()

  const stop = (): void => {
    if (stopped) return
    stopped = true
    doc.off('updateV2', handler)
    cancelTimer?.()
    cancelTimer = null
    // The batch being appended right now settles with its own result; the others were never written.
    const lost = queue.slice(inFlight)
    for (const item of lost) item.reject?.(new CaptureStoppedError(queue.length, lastError))
  }

  return Object.assign(stop, {
    stop,
    unsaved: () => queue.length,
    blocked: () => isBlocked,
    retry: (): Promise<void> => {
      cancelTimer?.()
      cancelTimer = null
      void pump()
      return settled()
    },
    settled,
  })
}
