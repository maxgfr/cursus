import { useEffect, useSyncExternalStore } from 'react'
import type { Runtime } from '../../app/workspaceContext.tsx'
import { migrateDeckRuns } from '../../core/ai/deckRuns'
import type { AiJob, AiJobs, JobsState } from '../../core/ai/jobs'
import type { Id } from '../../core/contracts/workspace'
import { noteError } from '../../screens/settings/Diagnostic/recent.ts'

/**
 * Cards suggested on a source when the student asks (« Suggest cards » on a source, its slides, a photo), as
 * every screen sees them: `proposeFor(rt, id)` queues the source, and the queue's state for the screens that
 * show it. Nothing is ever queued on its own when a source is added.
 *
 * Nothing here loads the AI code: the queue (`screens/Inbox/runner.ts`, the jobs and the AI SDK) is fetched the
 * first time a source is queued, the inbox opens, or a stored job needs to run again.
 */

/** Where the device store keeps the queue: `JOBS_KEY` of `core/ai/jobs` (importing it would load the AI code). */
export const STORED_JOBS_KEY = 'ai:jobs'

let opening: Promise<AiJobs> | null = null
let queue: AiJobs | null = null
let snapshot: JobsState = { loaded: false, jobs: [], running: null }
const listeners = new Set<() => void>()

function publish(next: JobsState): void {
  snapshot = next
  for (const fn of [...listeners]) fn()
}

/** The device's queue, started (and its waiting jobs checked again) on first use. */
export function autoQuestions(rt: Runtime): Promise<AiJobs> {
  if (opening) return opening
  const started = import('../../screens/Inbox/runner.ts').then(async ({ createRunner }) => {
    const q = createRunner(rt)
    q.subscribe(publish)
    queue = q
    await q.start()
    // Jobs left waiting for a connection or a model are looked at again now.
    await q.kick()
    return q
  })
  opening = started
  started.catch((e: unknown) => {
    // The next call tries again (a chunk that failed to load, a device store that refused a read).
    if (opening === started) opening = null
    queue = null
    noteError('autoQuestions.start', e)
  })
  return started
}

/** Queues the cards the student asked for on a source. Resolves with the job id, or null when it could not be queued. */
export async function proposeFor(rt: Runtime, sourceId: Id): Promise<string | null> {
  try {
    return await (await autoQuestions(rt)).enqueue(sourceId)
  } catch (e) {
    noteError('autoQuestions.enqueue', e)
    return null
  }
}

const ACTIVE: ReadonlySet<string> = new Set(['queued', 'running', 'waiting', 'needs-model'])

function storedJob(v: unknown): v is AiJob {
  if (typeof v !== 'object' || v === null) return false
  const j = v as Record<string, unknown>
  return (
    typeof j.id === 'string' &&
    typeof j.sourceId === 'string' &&
    typeof j.status === 'string' &&
    typeof j.updatedAt === 'number' &&
    typeof j.progress === 'object' &&
    j.progress !== null
  )
}

/** The queue as stored on this device (read without loading the queue's code). */
export async function readStoredJobs(rt: Runtime): Promise<AiJob[]> {
  const raw = await rt.store.read(['kv'], (tx) => tx.get<unknown>('kv', STORED_JOBS_KEY))
  if (typeof raw !== 'object' || raw === null) return []
  const jobs = (raw as { jobs?: unknown }).jobs
  return Array.isArray(jobs) ? jobs.filter(storedJob) : []
}

/**
 * Runs again what the stored queue still has to do: jobs the student asked for that were queued or interrupted
 * (the app was closed), or waiting for a connection or a model.
 */
export async function resumeAutoQuestions(rt: Runtime): Promise<void> {
  await keepDeckRuns(rt)
  try {
    if (queue) {
      await queue.kick()
      return
    }
    const jobs = await readStoredJobs(rt)
    const pending = jobs.some(
      (j) =>
        j.reason === 'manual' &&
        (j.status === 'queued' || j.status === 'running' || j.status === 'waiting' || j.status === 'needs-model'),
    )
    if (pending) await autoQuestions(rt)
  } catch (e) {
    noteError('autoQuestions.resume', e)
  }
}

/** Questions left on the former « Create cards » screen join « Suggested cards » (once; a failure tries again later). */
export async function keepDeckRuns(rt: Runtime): Promise<void> {
  try {
    await migrateDeckRuns(rt.ws, rt.store)
  } catch (e) {
    noteError('autoQuestions.deckRuns', e)
  }
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
const current = () => snapshot

/**
 * The queue's jobs for a screen: live once the queue runs in this tab, else as stored (read when the screen
 * opens). `start` loads and starts the queue (the review screen, where its actions are).
 */
export function useAutoJobs(rt: Runtime, o: { start?: boolean } = {}): JobsState {
  const start = o.start === true
  useEffect(() => {
    if (start) {
      // A failure to start is recorded by `autoQuestions` itself; the screen keeps showing the stored state.
      autoQuestions(rt).catch(() => undefined)
      return
    }
    if (queue) return
    let live = true
    readStoredJobs(rt).then(
      (jobs) => {
        if (live && !queue) publish({ loaded: true, jobs, running: null })
      },
      (e: unknown) => noteError('autoQuestions.read', e),
    )
    return () => {
      live = false
    }
  }, [rt, start])
  return useSyncExternalStore(subscribe, current)
}

/** The newest job of a source, if any. */
export function jobOf(jobs: readonly AiJob[], sourceId: Id): AiJob | undefined {
  let out: AiJob | undefined
  for (const j of jobs) if (j.sourceId === sourceId && (!out || j.updatedAt >= out.updatedAt)) out = j
  return out
}

export const isActiveJob = (j: Pick<AiJob, 'status'>): boolean => ACTIVE.has(j.status)

/** The live queue's commands, once it runs (the review screen starts it). */
export function liveQueue(): AiJobs | null {
  return queue
}
