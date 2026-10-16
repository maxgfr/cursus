import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import * as Y from 'yjs'
import type { Clock, Locks, Rng } from '../core/contracts/ports'
import type { Scope } from '../core/contracts/workspace'
import { createLocalLog, type LocalLogImpl } from '../core/log/localLog'
import { type Capture, captureUpdates, REPLAY } from '../core/log/origins'
import { createWorkspace, type ModelWorkspace } from '../core/model/workspace'
import { systemClock } from '../core/ports/clock'
import { defaultLocks } from '../core/ports/locks'
import { cryptoRng } from '../core/ports/rng'
import type { ReplaySnapshot } from '../core/srs/fsrs'
import { readSavedReplays } from '../core/srs/savedReplays'
import { type IdbStore, idbStore } from '../core/storage/idbStore'

/** Seal after this much quiet, and at most this long after the first unsealed edit. */
const SEAL_QUIET_MS = 10_000
const SEAL_MAX_MS = 60_000

/** Everything the app layer needs from the local replica. Screens only see the Workspace. */
export interface Runtime {
  readonly ws: ModelWorkspace
  readonly doc: Y.Doc
  readonly store: IdbStore
  /** The replays an earlier launch saved, read before the replica was ready (null: none, unreadable or late). */
  readonly replays: ReplaySnapshot | null
  readonly log: LocalLogImpl
  readonly locks: Locks
  readonly clock: Clock
  readonly rng: Rng
  readonly capture: Capture
  /** Seals pending edits into a segment now. */
  seal(): Promise<void>
  /** Save state changes (unsaved count, blocked append, IndexedDB version change). */
  subscribeSave(fn: () => void): () => void
  readonly versionChanged: () => boolean
  /** Called after each seal that produced a segment (the sync scheduler listens). */
  onSealed(fn: () => void): () => void
  /**
   * Stops writing to this device's library, for good (« Erase everything »): no more seals (timers, page hidden or
   * left), no more capture of edits, and the store disposed so nothing reopens the database.
   */
  shutdown(): void
}

export interface ReplicaDeps {
  store: IdbStore
  locks: Locks
  clock: Clock
  rng: Rng
  /** Reads the replays an earlier launch saved; never rejects and is bounded (default `readSavedReplays`). */
  readReplays?: (store: IdbStore) => Promise<ReplaySnapshot | null>
}

/**
 * Loads the persisted log into a fresh doc (origin REPLAY, never captured) and, alongside it, the replays an
 * earlier launch saved: the replica is ready only with both, so the first study computation starts from those
 * replays instead of racing them. Their read is bounded and never fails the launch (a full replay instead).
 */
export async function loadReplica(
  deps: ReplicaDeps,
): Promise<{ log: LocalLogImpl; doc: Y.Doc; ws: ModelWorkspace; replays: ReplaySnapshot | null }> {
  const { store, locks, clock, rng } = deps
  const log = createLocalLog({ store, locks, clock, rng })
  const replays = (deps.readReplays ?? readSavedReplays)(store)
  const { updates } = await log.load()
  const deviceId = await log.deviceId()
  const doc = new Y.Doc()
  for (const u of updates) Y.applyUpdateV2(doc, u, REPLAY)
  const ws = createWorkspace(doc, { rng, clock, deviceId })
  return { log, doc, ws, replays: await replays }
}

/**
 * Opens the local replica (see `loadReplica`), then captures every later local edit. Nothing is written to
 * the doc here.
 */
async function openRuntime(): Promise<Runtime> {
  const listeners = new Set<() => void>()
  const sealedListeners = new Set<() => void>()
  const notify = () => {
    for (const fn of listeners) fn()
  }
  let versionChanged = false
  const store = idbStore({
    onVersionChange: () => {
      versionChanged = true
      notify()
    },
  })
  const locks = defaultLocks()
  const clock = systemClock
  const rng = cryptoRng(clock)
  const { log, doc, ws, replays } = await loadReplica({ store, locks, clock, rng })

  let quietTimer: ReturnType<typeof setTimeout> | undefined
  let firstUnsealedAt: number | undefined
  let sealing: Promise<void> = Promise.resolve()
  let down = false
  const seal = (): Promise<void> => {
    if (down) return Promise.resolve()
    clearTimeout(quietTimer)
    quietTimer = undefined
    firstUnsealedAt = undefined
    const run = async (): Promise<void> => {
      await capture.settled()
      const rec = await log.seal()
      if (rec) for (const fn of sealedListeners) fn()
    }
    // A failed seal was reported to its own caller; the next one still runs.
    sealing = sealing.then(run, run)
    return sealing
  }
  const scheduleSeal = () => {
    if (down) return
    const now = clock.now()
    firstUnsealedAt ??= now
    clearTimeout(quietTimer)
    const wait = Math.max(0, Math.min(SEAL_QUIET_MS, firstUnsealedAt + SEAL_MAX_MS - now))
    quietTimer = setTimeout(() => void seal(), wait)
  }
  const capture = captureUpdates(doc, (u) => log.appendLocal(u), {
    onChange: notify,
    onQueued: (ack) => {
      ack.then(scheduleSeal, notify)
    },
  })
  const sealNow = () => {
    if (document.visibilityState === 'hidden') void seal()
  }
  const sealOnLeave = () => void seal()
  document.addEventListener('visibilitychange', sealNow)
  window.addEventListener('pagehide', sealOnLeave)

  return {
    ws,
    doc,
    store,
    replays,
    log,
    locks,
    clock,
    rng,
    capture,
    seal,
    subscribeSave: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    versionChanged: () => versionChanged,
    onSealed: (fn) => {
      sealedListeners.add(fn)
      return () => sealedListeners.delete(fn)
    },
    shutdown: () => {
      down = true
      clearTimeout(quietTimer)
      quietTimer = undefined
      document.removeEventListener('visibilitychange', sealNow)
      window.removeEventListener('pagehide', sealOnLeave)
      capture.stop()
      store.dispose()
    },
  }
}

type BootState = { phase: 'loading' } | { phase: 'ready'; rt: Runtime } | { phase: 'error'; error: unknown }

// One replica per page, even under StrictMode's double effects.
let opening: Promise<Runtime> | null = null

/**
 * Starts opening the local replica at once, before the first render: reading and inflating the library
 * then overlaps the language catalog's load instead of waiting for it. The provider picks up this same
 * opening and shows its failure, if any (with a retry).
 */
export function openReplicaEarly(): void {
  if (opening !== null) return
  const started = openRuntime()
  opening = started
  // Handled by the provider once it mounts: until then the rejection must not count as unhandled.
  started.catch(() => undefined)
}

const RuntimeContext = createContext<Runtime | null>(null)

export interface WorkspaceProviderProps {
  children: ReactNode
  loading: ReactNode
  failed: (error: unknown, retry: () => void) => ReactNode
}

export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  // A new key restarts the boot from scratch after a failure.
  return <Boot key={attempt} {...props} retry={retry} />
}

function Boot({ children, loading, failed, retry }: WorkspaceProviderProps & { retry: () => void }) {
  const [state, setState] = useState<BootState>({ phase: 'loading' })

  useEffect(() => {
    let live = true
    opening ??= openRuntime()
    opening.then(
      (rt) => {
        if (live) setState({ phase: 'ready', rt })
      },
      (error: unknown) => {
        opening = null
        if (live) setState({ phase: 'error', error })
      },
    )
    return () => {
      live = false
    }
  }, [])

  if (state.phase === 'loading') return loading
  if (state.phase === 'error') return failed(state.error, retry)
  return <RuntimeContext.Provider value={state.rt}>{children}</RuntimeContext.Provider>
}

export function useRuntime(): Runtime {
  const rt = useContext(RuntimeContext)
  if (rt === null) throw new Error('useRuntime must be used inside <WorkspaceProvider>')
  return rt
}

/** The workspace: the only way screens read or change data. */
export function useWorkspace(): ModelWorkspace {
  return useRuntime().ws
}

function scopeKey(scopes: readonly Scope[]): string {
  return scopes.map((s) => (typeof s === 'string' ? s : `#${s.id}`)).join('|')
}

function parseScopes(key: string): Scope[] {
  if (key === '') return []
  return key.split('|').map((s) => (s.startsWith('#') ? { id: s.slice(1) } : (s as Scope)))
}

/** Re-reads `read(ws)` whenever one of the scopes changes; stable between changes. */
export function useWorkspaceData<T>(scopes: readonly Scope[], read: (ws: ModelWorkspace) => T): T {
  const ws = useWorkspace()
  const key = scopeKey(scopes)
  const version = useRef(0)
  const subscribe = useCallback(
    (onChange: () => void) => {
      const offs = parseScopes(key).map((s) =>
        ws.subscribe(s, () => {
          version.current++
          onChange()
        }),
      )
      return () => {
        for (const off of offs) off()
      }
    },
    [ws, key],
  )
  const v = useSyncExternalStore(subscribe, () => version.current)
  const cache = useRef<{ v: number; key: string; ws: ModelWorkspace; value: T } | null>(null)
  const c = cache.current
  if (c === null || c.v !== v || c.key !== key || c.ws !== ws) {
    cache.current = { v, key, ws, value: read(ws) }
    return cache.current.value
  }
  return c.value
}

export interface SaveState {
  unsaved: number
  blocked: boolean
  versionChanged: boolean
}

/** Local durability, straight from the capture queue: "not saved on this device" when blocked. */
export function useSaveState(): SaveState {
  const rt = useRuntime()
  const snapshot = useRef<SaveState>({ unsaved: 0, blocked: false, versionChanged: false })
  const get = useCallback((): SaveState => {
    const next = { unsaved: rt.capture.unsaved(), blocked: rt.capture.blocked(), versionChanged: rt.versionChanged() }
    const prev = snapshot.current
    if (prev.unsaved === next.unsaved && prev.blocked === next.blocked && prev.versionChanged === next.versionChanged)
      return prev
    snapshot.current = next
    return next
  }, [rt])
  return useSyncExternalStore(rt.subscribeSave, get)
}
