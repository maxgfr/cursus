import { useEffect, useSyncExternalStore } from 'react'
import type { Runtime } from '../../app/workspaceContext.tsx'
import type { JobReason } from '../../core/ai/autoQuestions'
import type { AiJob, AiJobs, JobsState } from '../../core/ai/jobs'
import type { Id } from '../../core/contracts/workspace'
import { noteError } from '../../screens/settings/Diagnostic/recent.ts'
import { isAiReady } from '../ai/ready.ts'

/**
 * Questions proposed when a source is added, as every add path and screen sees them: `proposeFor(rt, id)` after
 * a source is created, and the queue's state for the screens that show it.
 *
 * Nothing here loads the AI code: the queue (`screens/Inbox/runner.ts`, the jobs and the AI SDK) is fetched the
 * first time a source is queued, the review screen opens, or a stored job needs to run again.
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

/**
 * Queues questions for a source just added (`added`: follows the « When I add a document » setting) or asked for
 * (`manual`). Resolves with the job id, or null when the setting says to do nothing or no model is set up (a
 * source added without one is never queued for later).
 */
export async function proposeFor(rt: Runtime, sourceId: Id, reason: JobReason = 'added'): Promise<string | null> {
  if (reason === 'added' && rt.ws.drafts.settings.get().mode === 'off') return null
  try {
    if (reason === 'added' && !(await isAiReady(rt))) return null
    return await (await autoQuestions(rt)).enqueue(sourceId, reason)
  } catch (e) {
    noteError('autoQuestions.enqueue', e)
    return null
  }
}

/** Notes created empty, proposed once the student leaves them with something written. */
const freshNotes = new Set<Id>()

export function proposeWhenWritten(sourceId: Id): void {
  freshNotes.add(sourceId)
}

/** The student left a note: a fresh one with text in it is proposed now (an empty one keeps waiting). */
export function leftNote(rt: Runtime, sourceId: Id): void {
  if (!freshNotes.has(sourceId)) return
  if (rt.ws.text({ id: sourceId, field: 'body' }).toString().trim() === '') return
  freshNotes.delete(sourceId)
  void proposeFor(rt, sourceId)
}

const ACTIVE: ReadonlySet<string> = new Set(['queued', 'running', 'waiting', 'needs-model', 'over-cap'])

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
 * Runs again what the stored queue still has to do: jobs queued or interrupted (the app was closed), waiting for
 * a connection, and when asked those waiting for a model (one was just set up) or over a cap (the caps changed).
 */
export async function resumeAutoQuestions(rt: Runtime, o: { model?: boolean; overCap?: boolean } = {}): Promise<void> {
  try {
    if (queue) {
      await queue.kick(o.overCap ? { overCap: true } : undefined)
      return
    }
    const jobs = await readStoredJobs(rt)
    const pending = jobs.some(
      (j) =>
        j.status === 'queued' ||
        j.status === 'running' ||
        j.status === 'waiting' ||
        (o.model === true && j.status === 'needs-model') ||
        (o.overCap === true && j.status === 'over-cap'),
    )
    if (!pending) return
    const q = await autoQuestions(rt)
    if (o.overCap) await q.kick({ overCap: true })
  } catch (e) {
    noteError('autoQuestions.resume', e)
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
