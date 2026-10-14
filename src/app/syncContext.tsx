import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { SyncEngineImpl } from '../core/sync/engine'
import type { SyncScheduler } from '../core/sync/scheduler'
import type { EngineStatus } from '../core/sync/status'
import { noteError } from '../screens/settings/Diagnostic/recent.ts'
import type { SyncSummary } from '../ui/components/Badges.tsx'
import { guardChunk } from './chunkGuard.ts'
import type { OAuthOutcome } from './destinations.ts'
import { summarize } from './syncSummary.ts'
import { useRuntime, useSaveState } from './workspaceContext.tsx'

export { summarize }

type ConfirmWorkspace = (q: { dest: string; local: string | null; remote: string[] }) => Promise<boolean>

export interface SyncValue {
  /** Verified engine status; null until the engine has read its state. */
  status: EngineStatus | null
  online: boolean
  summary: SyncSummary
  engine: SyncEngineImpl | null
  scheduler: SyncScheduler | null
  /** A failure starting the engine (shown as "needs attention"). */
  error: unknown
  /** Back from a provider's consent page: the destination connected at boot, or why it failed. */
  oauth: OAuthOutcome | null
  dismissOAuth(): void
  /**
   * Installs the UI that asks before merging a different workspace into a non-empty library.
   * Until one is installed, the answer is no: a CRDT merge cannot be undone.
   */
  setWorkspaceConfirmer(fn: ConfirmWorkspace | null): void
}

const SyncContext = createContext<SyncValue | null>(null)

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

interface Started {
  engine: SyncEngineImpl
  scheduler: SyncScheduler
  oauth: OAuthOutcome | null
}

// One engine per page, even under StrictMode's double effects.
let starting: Promise<Started> | null = null

/** Starts the sync engine and its scheduler (loaded on demand, after the first paint). */
export function SyncProvider({ children }: { children: ReactNode }) {
  const rt = useRuntime()
  const save = useSaveState()
  const online = useOnline()
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [started, setStarted] = useState<Started | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [oauth, setOAuth] = useState<OAuthOutcome | null>(null)
  const confirmer = useRef<ConfirmWorkspace | null>(null)
  // Bumped on every local change; `stale` holds until a refresh started after it has finished.
  const localEpoch = useRef(0)
  const [stale, setStale] = useState(false)

  useEffect(() => {
    let live = true
    let unsubscribe = () => {}
    starting ??= (async (): Promise<Started> => {
      const [
        { createAppEngine, bootDestinations, pendingOAuthKey, clearOAuthParam },
        { createScheduler, browserTimers },
        { blobStore },
      ] = await guardChunk(
        () => Promise.all([import('./destinations.ts'), import('../core/sync/scheduler'), import('../core/log/blobs')]),
        'sync.engine',
        noteError,
      )
      const engine = createAppEngine({
        store: rt.store,
        log: rt.log,
        blobs: blobStore(rt.store),
        locks: rt.locks,
        clock: rt.clock,
        rng: rt.rng,
        doc: rt.doc,
        unsaved: () => rt.capture.unsaved(),
        confirmWorkspace: (q) => (confirmer.current ? confirmer.current(q) : Promise.resolve(false)),
      })
      const scheduler = createScheduler({
        engine,
        clock: rt.clock,
        rng: rt.rng,
        timers: browserTimers,
        isVisible: () => document.visibilityState === 'visible',
        isOnline: () => navigator.onLine,
      })
      await engine.refresh()
      scheduler.start()
      scheduler.trigger('startup')
      rt.onSealed(() => scheduler.trigger('sealed'))
      // Sync runs from launch: every remembered destination rejoins, and a pending OAuth return is
      // finished here, whatever screen the app opened on.
      const oauthKey = pendingOAuthKey()
      clearOAuthParam()
      const oauth = await bootDestinations(rt, engine, scheduler, oauthKey)
      return { engine, scheduler, oauth }
    })()
    starting.then(
      (s) => {
        if (!live) return
        setStarted(s)
        setOAuth(s.oauth)
        setStatus(s.engine.status())
        unsubscribe = s.engine.subscribe(setStatus)
      },
      (e: unknown) => {
        starting = null
        if (live) setError(e)
      },
    )
    return () => {
      live = false
      unsubscribe()
    }
  }, [rt])

  useEffect(() => {
    if (!started) return
    const visible = () => {
      if (document.visibilityState === 'visible') started.scheduler.trigger('visible')
    }
    const back = () => started.scheduler.trigger('online')
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('online', back)
    return () => {
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('online', back)
    }
  }, [started])

  useEffect(() => {
    const changed = () => {
      const epoch = ++localEpoch.current
      setStale(true)
      if (!started) return
      started.engine.refresh().then(
        () => {
          if (localEpoch.current === epoch) setStale(false)
        },
        (e: unknown) => {
          // Stays stale (never "protected") and surfaces the failure as "needs attention".
          if (localEpoch.current === epoch) setError(e)
        },
      )
    }
    const offSave = rt.subscribeSave(changed)
    const offSealed = rt.onSealed(changed)
    // Anything captured before the engine started is counted by its first refresh.
    if (started && localEpoch.current > 0) changed()
    return () => {
      offSave()
      offSealed()
    }
  }, [rt, started])

  const value = useMemo<SyncValue>(
    () => ({
      status,
      online,
      summary: summarize(status, save, online, error, stale),
      engine: started?.engine ?? null,
      scheduler: started?.scheduler ?? null,
      error,
      oauth,
      dismissOAuth: () => setOAuth(null),
      setWorkspaceConfirmer: (fn) => {
        confirmer.current = fn
      },
    }),
    [status, online, save, error, started, stale, oauth],
  )
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}

export function useSync(): SyncValue {
  const v = useContext(SyncContext)
  if (v === null) throw new Error('useSync must be used inside <SyncProvider>')
  return v
}
