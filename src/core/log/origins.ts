import type * as Y from 'yjs'

/** Transaction origins that must NOT be captured into `pending`: they already exist in the log. */
export const REMOTE = Symbol('cursus:remote') // applied from a destination
export const TAB = Symbol('cursus:tab') // relayed from another tab via since()
export const REPLAY = Symbol('cursus:replay') // load / replay of the persisted log

const IGNORED: ReadonlySet<unknown> = new Set([REMOTE, TAB, REPLAY])

/** Everything else is captured, including UndoManager origins: undo/redo are local edits. */
export function shouldCapture(origin: unknown): boolean {
  return !IGNORED.has(origin)
}

/**
 * Captures every local V2 update into the log. Failures (e.g. LocalQuotaError) go to onError so the
 * caller can keep the update in memory and show the "not saved on this device" banner.
 */
export function captureUpdates(
  doc: Y.Doc,
  append: (update: Uint8Array) => Promise<void>,
  onError: (e: unknown, update: Uint8Array) => void,
): () => void {
  const handler = (update: Uint8Array, origin: unknown) => {
    if (!shouldCapture(origin)) return
    append(update).catch((e: unknown) => onError(e, update))
  }
  doc.on('updateV2', handler)
  return () => doc.off('updateV2', handler)
}
