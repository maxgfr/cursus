/**
 * The device's background AI queue: questions proposed on the sources the student asks about, one source at a
 * time.
 *
 * - Persisted in the device store (`kv`, key `ai:jobs`), never synced: closing the app keeps the queue, and a
 *   job resumes where it stopped (units already read are skipped; their drafts are already in the doc).
 * - Drafts are written to the workspace batch by batch, so they sync as they come and nothing read is lost.
 * - Never runs without a configured model (`needs-model`), nor offline with an online model (`waiting`,
 *   `waitReason: 'offline'`). What a run costs is recorded with the usage, against its source.
 * - Cancellable (`cancel`), retryable (`retry`); `stop` interrupts the running job without cancelling it.
 * - Only the student starts a job: a job queued on its own by an earlier version (when a source was added) is
 *   cancelled when the queue is read, never run.
 * - Tabs: one runs the queue at a time (lock `cursus:ai-jobs:run`); every change to the stored queue is a
 *   read-modify-write under `cursus:ai-jobs:store`. Another tab's view refreshes with `refresh()`.
 *
 * The Today line counts come from the workspace (`ws.drafts.summary()`), not from here: proposed drafts sync.
 */
import type { Clock, LocalStore, Locks, Rng } from '../contracts/ports'
import type { Id } from '../contracts/workspace'
import type { SourceRecord } from '../model/schema'
import type { ModelWorkspace } from '../model/workspace'
import {
  deckGenerator,
  type JobOptions,
  type JobReason,
  optionsKey,
  type PlanOutcome,
  parseJobOptions,
  planRun,
  type QuestionGenerator,
  type RunPlan,
  type SourceContent,
  toNewDrafts,
  unitsLanguage,
} from './autoQuestions'
import type { CatalogModel } from './catalogTrim'
import type { FeatureCtx } from './client'
import type { DeckQuestion, DeckQuestionsInput } from './features/deckQuestions'

export const JOBS_KEY = 'ai:jobs'
export const JOBS_STORE_LOCK = 'cursus:ai-jobs:store'
export const JOBS_RUN_LOCK = 'cursus:ai-jobs:run'
/** Finished jobs kept for the UI (newest first); active ones are always kept. */
export const KEEP_FINISHED = 20

export type JobStatus = 'queued' | 'running' | 'waiting' | 'needs-model' | 'done' | 'failed' | 'cancelled'
/** How a finished job ended (`added` and `off`: stored by earlier versions only). */
export type JobOutcome = 'proposed' | 'added' | 'off' | 'source-gone' | 'empty'

export interface JobEstimate {
  /** USD of what is left to read (0 on an on-device model). */
  cost: number
  calls: number
  units: number
}

export interface AiJob {
  id: string
  sourceId: Id
  reason: JobReason
  /** What the student chose (« Generate cards »); absent = the defaults. */
  options?: JobOptions
  status: JobStatus
  createdAt: number
  updatedAt: number
  waitReason?: 'offline'
  estimate?: JobEstimate
  /** USD this job spent on its source so far. */
  spent: number
  /** Units read (slides, pages, sections) out of `total`. */
  progress: { done: number[]; total: number }
  /** Drafts written (and, from earlier versions, cards added directly). */
  proposed: number
  added: number
  duplicates: number
  outcome?: JobOutcome
  error?: string
  /** `provider/model` of the last run. */
  model?: string
}

export interface JobsState {
  /** False until the stored queue was read. */
  loaded: boolean
  /** Oldest first. */
  jobs: readonly AiJob[]
  /** The job running in this tab. */
  running: string | null
  /** The queue itself failed (the device store refused a write): shown, and the queue stops. */
  error?: string
}

/** The model from the AI settings, ready to call; `local` runs on this device (no connection, no cost). */
export interface JobModel {
  info: CatalogModel
  local: boolean
  /** A feature context answering in `language` (an output language name). */
  context(signal: AbortSignal, language: string): Promise<FeatureCtx>
}

export interface JobsDeps {
  ws: ModelWorkspace
  store: LocalStore
  locks: Locks
  clock: Clock
  rng: Rng
  network: { online(): boolean; subscribe?(fn: () => void): () => void }
  /** The configured model, or null when none is set up (or not usable on this device). */
  model(): Promise<JobModel | null>
  /** The source's units (decks, documents, PDFs, notes, a photo) the options cover; null when it cannot be read here. */
  content(source: SourceRecord, signal: AbortSignal, options?: JobOptions): Promise<SourceContent | null>
  /** Generators by source kind (e.g. `image`: a `photoToCards` adapter); `deckQuestions` otherwise. */
  generators?: Partial<Record<SourceRecord['kind'], QuestionGenerator>>
}

/** What running a source would cost now, for the « coût estimé » before anything runs. */
export type SourceEstimate =
  | { kind: 'needs-model' }
  | { kind: 'source-gone' }
  | { kind: 'empty' }
  | { kind: 'ok'; estimate: JobEstimate; local: boolean }

export interface AiJobs {
  /** Reads the stored queue and starts running it (in the background: `idle` waits for it). */
  start(): Promise<void>
  /** Interrupts the running job (it resumes on the next start) and stops the queue. */
  stop(): void
  /**
   * Queues a source the student asked about, with what they chose. A source already queued or waiting with the same
   * choices keeps its job, whose id is returned.
   */
  enqueue(sourceId: Id, options?: JobOptions): Promise<string>
  state(): JobsState
  subscribe(fn: (s: JobsState) => void): () => void
  cancel(id: string): Promise<void>
  /** Queues a failed, cancelled or waiting job again (a finished one starts over). */
  retry(id: string): Promise<void>
  /** Re-checks jobs waiting for a connection or a model. */
  kick(): Promise<void>
  /** Re-reads the stored queue (another tab may have changed it). */
  refresh(): Promise<void>
  estimate(sourceId: Id, options?: JobOptions): Promise<SourceEstimate>
  /** Resolves once the queue has nothing more to run now. */
  idle(): Promise<void>
}

const ACTIVE: ReadonlySet<JobStatus> = new Set(['queued', 'running', 'waiting', 'needs-model'])
/** `over-cap`: held by a cost cap in earlier versions; read as cancelled (the student can try again). */
const STATUSES: ReadonlySet<string> = new Set([...ACTIVE, 'done', 'failed', 'cancelled', 'over-cap'])

class JobAbort extends Error {
  constructor(readonly why: 'cancel' | 'stop') {
    super(`job ${why}`)
    this.name = 'JobAbort'
  }
}

const abortOf = (signal: AbortSignal): JobAbort['why'] | null =>
  signal.aborted && signal.reason instanceof JobAbort ? signal.reason.why : null

function isJob(v: unknown): v is AiJob {
  if (typeof v !== 'object' || v === null) return false
  const j = v as Record<string, unknown>
  const p = j.progress as Record<string, unknown> | undefined
  return (
    typeof j.id === 'string' &&
    typeof j.sourceId === 'string' &&
    (j.reason === 'added' || j.reason === 'manual') &&
    typeof j.status === 'string' &&
    STATUSES.has(j.status) &&
    typeof j.createdAt === 'number' &&
    typeof j.spent === 'number' &&
    typeof p === 'object' &&
    p !== null &&
    Array.isArray(p.done)
  )
}

/** Fields of earlier versions' cost caps: dropped when a job is read. */
const LEGACY = ['cap', 'approved', 'overspent'] as const

/**
 * A stored job as this version runs it: one held by a cost cap is cancelled, and so is one still waiting that was
 * queued on its own when its source was added (nothing runs without the student asking).
 */
function current(j: AiJob, now: number): AiJob {
  const raw = j as AiJob & Partial<Record<(typeof LEGACY)[number], unknown>>
  const legacy = LEGACY.some((k) => k in raw)
  const stale = (j.status as string) === 'over-cap' || (j.reason === 'added' && ACTIVE.has(j.status))
  if (!legacy && !stale) return j
  const out: Record<string, unknown> = { ...raw }
  for (const k of LEGACY) delete out[k]
  if (stale) {
    out.status = 'cancelled'
    delete out.waitReason
    out.updatedAt = now
  }
  return out as unknown as AiJob
}

/** Options this version reads; none left, the field goes. */
function withOptions(j: AiJob): AiJob {
  if (!('options' in j)) return j
  const options = parseJobOptions(j.options)
  const { options: _, ...rest } = j
  return options ? { ...rest, options } : rest
}

/** The stored queue; entries this version cannot read are left out. */
export function parseJobs(raw: unknown, now = 0): AiJob[] {
  if (typeof raw !== 'object' || raw === null) return []
  const jobs = (raw as { jobs?: unknown }).jobs
  return Array.isArray(jobs) ? jobs.filter(isJob).map((j) => withOptions(current(j, now))) : []
}

/** Oldest first; jobs queued in the same millisecond keep their order (the sorts are stable). */
const byAge = (a: AiJob, b: AiJob): number => a.createdAt - b.createdAt

function prune(jobs: AiJob[]): AiJob[] {
  const finished = jobs
    .filter((j) => !ACTIVE.has(j.status))
    .sort((a, b) => b.updatedAt - a.updatedAt || byAge(b, a) || jobs.indexOf(b) - jobs.indexOf(a))
    .slice(0, KEEP_FINISHED)
  const keep = new Set(finished)
  return jobs.filter((j) => ACTIVE.has(j.status) || keep.has(j)).sort(byAge)
}

/** Assigns a patch; `undefined` removes a field (the stored JSON never holds `undefined`). */
function apply(j: AiJob, p: Partial<AiJob>, now: number): AiJob {
  const out: Record<string, unknown> = { ...j }
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  out.updatedAt = now
  return out as unknown as AiJob
}

const modelName = (info: CatalogModel): string => `${info.provider}/${info.id}`

interface Prepared {
  plan: RunPlan
  content: SourceContent
  generator: QuestionGenerator
  input: DeckQuestionsInput
  estimate: JobEstimate
}

class JobQueue implements AiJobs {
  private snapshot: JobsState = { loaded: false, jobs: [], running: null }
  private readonly listeners = new Set<(s: JobsState) => void>()
  private started = false
  private stopped = false
  private pumping: Promise<void> | null = null
  private again = false
  private current: { id: string; controller: AbortController } | null = null
  private offNetwork: (() => void) | null = null

  constructor(private readonly deps: JobsDeps) {}

  // ---- state ----

  state(): JobsState {
    return this.snapshot
  }

  subscribe(fn: (s: JobsState) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private publish(p: Partial<JobsState>): void {
    this.snapshot = { ...this.snapshot, ...p }
    for (const fn of [...this.listeners]) fn(this.snapshot)
  }

  private find(id: string): AiJob | undefined {
    return this.snapshot.jobs.find((j) => j.id === id)
  }

  /** Read-modify-write of the stored queue under the store lock; writes only when something changed. */
  private async mutate(fn: (jobs: AiJob[]) => AiJob[]): Promise<void> {
    await this.deps.locks.run(JOBS_STORE_LOCK, async () => {
      const raw = await this.deps.store.read(['kv'], (tx) => tx.get<unknown>('kv', JOBS_KEY))
      const stored = parseJobs(raw)
      const before = parseJobs(raw, this.deps.clock.now())
      const next = prune(fn(before.map((j) => ({ ...j }))))
      if (JSON.stringify(next) !== JSON.stringify(stored)) {
        await this.deps.store.commit([{ put: 'kv', key: JOBS_KEY, value: { v: 1, jobs: next } }])
      }
      this.publish({ loaded: true, jobs: next })
    })
  }

  private patch(id: string, p: Partial<AiJob>, o?: { keepCancelled?: boolean }): Promise<void> {
    const now = this.deps.clock.now()
    return this.mutate((jobs) =>
      jobs.map((j) => {
        if (j.id !== id) return j
        if (o?.keepCancelled && j.status === 'cancelled') {
          // Cancelled meanwhile (maybe from another tab): keep what was done, never the new status.
          const rest: Partial<AiJob> = { ...p }
          delete rest.status
          delete rest.waitReason
          delete rest.outcome
          if (this.current?.id === id) this.current.controller.abort(new JobAbort('cancel'))
          return apply(j, rest, now)
        }
        return apply(j, p, now)
      }),
    )
  }

  refresh(): Promise<void> {
    return this.mutate((jobs) => jobs)
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    this.started = true
    this.stopped = false
    if (!this.offNetwork && this.deps.network.subscribe) {
      this.offNetwork = this.deps.network.subscribe(() => {
        if (this.deps.network.online()) this.kick().catch((e: unknown) => this.fail(e))
      })
    }
    await this.refresh()
    void this.pump()
  }

  stop(): void {
    this.stopped = true
    this.offNetwork?.()
    this.offNetwork = null
    this.current?.controller.abort(new JobAbort('stop'))
  }

  idle(): Promise<void> {
    return this.pumping ?? Promise.resolve()
  }

  /** The device store refused the queue's own write: the queue stops and says why. */
  private fail(e: unknown): void {
    this.stopped = true
    this.publish({ error: e instanceof Error ? e.message : String(e) })
  }

  private pump(): Promise<void> {
    if (!this.started || this.stopped) return Promise.resolve()
    if (this.pumping) {
      this.again = true
      return this.pumping
    }
    const run = async (): Promise<void> => {
      do {
        this.again = false
        await this.deps.locks.run(JOBS_RUN_LOCK, () => this.drain())
      } while (this.again && !this.stopped)
    }
    this.pumping = run()
      .catch((e: unknown) => this.fail(e))
      .finally(() => {
        this.pumping = null
      })
    return this.pumping
  }

  /** Runs queued jobs, oldest first, until none is left (holding the run lock: no other tab runs one). */
  private async drain(): Promise<void> {
    // Holding the lock, a job still marked running was left by a closed app: it resumes.
    await this.mutate((jobs) => jobs.map((j) => (j.status === 'running' ? { ...j, status: 'queued' } : j)))
    while (!this.stopped) {
      const next = this.snapshot.jobs.filter((j) => j.status === 'queued').sort(byAge)[0]
      if (!next) return
      await this.run(next)
      await this.refresh()
    }
  }

  // ---- commands ----

  async enqueue(sourceId: Id, options?: JobOptions): Promise<string> {
    let id = ''
    const now = this.deps.clock.now()
    const chosen = parseJobOptions(options)
    const key = optionsKey(chosen)
    await this.mutate((jobs) => {
      const active = jobs.find((j) => j.sourceId === sourceId && ACTIVE.has(j.status) && optionsKey(j.options) === key)
      if (active) {
        id = active.id
        return jobs
      }
      const job: AiJob = {
        id: this.deps.rng.id(),
        sourceId,
        reason: 'manual',
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        spent: 0,
        progress: { done: [], total: 0 },
        proposed: 0,
        added: 0,
        duplicates: 0,
      }
      if (chosen) job.options = chosen
      id = job.id
      return [...jobs, job]
    })
    void this.pump()
    return id
  }

  async cancel(id: string): Promise<void> {
    await this.refresh()
    const job = this.find(id)
    if (!job || !ACTIVE.has(job.status)) return
    await this.patch(id, { status: 'cancelled', waitReason: undefined })
    if (this.current?.id === id) this.current.controller.abort(new JobAbort('cancel'))
  }

  async retry(id: string): Promise<void> {
    await this.refresh()
    const job = this.find(id)
    if (!job || job.status === 'queued' || job.status === 'running') return
    // Asked for again: it is the student's own from now on.
    const again: Partial<AiJob> = {
      reason: 'manual',
      status: 'queued',
      waitReason: undefined,
      error: undefined,
      outcome: undefined,
    }
    // A finished source is read again from the start: questions already proposed are dropped as duplicates.
    if (job.status === 'done') again.progress = { done: [], total: 0 }
    await this.patch(id, again)
    void this.pump()
  }

  async kick(): Promise<void> {
    const now = this.deps.clock.now()
    await this.mutate((jobs) =>
      jobs.map((j) =>
        j.status === 'waiting' || j.status === 'needs-model'
          ? apply(j, { status: 'queued', waitReason: undefined }, now)
          : j,
      ),
    )
    void this.pump()
  }

  async estimate(sourceId: Id, options?: JobOptions): Promise<SourceEstimate> {
    const chosen = parseJobOptions(options) ?? undefined
    const plan = planRun(this.deps.ws, sourceId, chosen)
    if (plan === 'source-gone') return { kind: 'source-gone' }
    const model = await this.deps.model()
    if (!model) return { kind: 'needs-model' }
    const prepared = await this.prepare(plan, model, [], new AbortController().signal, chosen)
    if (!prepared) return { kind: 'empty' }
    return { kind: 'ok', estimate: prepared.estimate, local: model.local }
  }

  // ---- running ----

  private async prepare(
    plan: RunPlan,
    model: JobModel,
    done: readonly number[],
    signal: AbortSignal,
    options?: JobOptions,
  ): Promise<Prepared | null> {
    const read = await this.deps.content(plan.source, signal, options)
    // Only the units asked for, whatever the reader gave.
    const asked = options?.units === undefined ? null : new Set(options.units)
    const content = read && asked ? { ...read, units: read.units.filter((u) => asked.has(u.index)) } : read
    if (!content || content.units.length === 0) return null
    const generator = this.deps.generators?.[plan.source.kind] ?? deckGenerator
    const resume = { done: Object.fromEntries(done.map((u) => [u, [] as DeckQuestion[]])) }
    const input: DeckQuestionsInput = { ...plan.input, units: content.units, resume }
    if (content.title && !input.deckTitle) input.deckTitle = content.title
    const e = generator.estimate(model.info, input)
    const estimate = { cost: model.local ? 0 : e.cost, calls: e.calls, units: e.units }
    return { plan, content, generator, input, estimate }
  }

  private async run(job: AiJob): Promise<void> {
    const { ws, network } = this.deps
    const id = job.id
    // Every write keeps a cancellation made meanwhile (maybe from another tab).
    const set = (p: Partial<AiJob>): Promise<void> => this.patch(id, p, { keepCancelled: true })
    const plan: PlanOutcome = planRun(ws, job.sourceId, job.options)
    if (plan === 'source-gone') {
      await set({ status: 'done', outcome: plan })
      return
    }
    const model = await this.deps.model()
    if (!model) {
      await set({ status: 'needs-model' })
      return
    }
    if (!model.local && !network.online()) {
      await set({ status: 'waiting', waitReason: 'offline' })
      return
    }
    const controller = new AbortController()
    this.current = { id, controller }
    this.publish({ running: id })
    let chain: Promise<void> = Promise.resolve()
    let spentNow = 0
    const done = new Set(job.progress.done)
    let total = job.progress.total
    try {
      await set({ status: 'running', model: modelName(model.info), error: undefined })
      const prepared = await this.prepare(plan, model, [...done], controller.signal, job.options)
      if (!prepared) {
        await set({ status: 'done', outcome: 'empty' })
        return
      }
      const { content, generator, input, estimate } = prepared
      total = content.units.length
      await set({ estimate, progress: { done: [...done].sort((a, b) => a - b), total } })
      // In the language asked for, else the course's, else the document's own.
      const language = plan.languageFromContent
        ? (unitsLanguage(content.units, this.deps.ws.prefs.get('locale')) ?? plan.language)
        : plan.language
      const base = await model.context(controller.signal, language)
      const ctx: FeatureCtx = {
        ...base,
        signal: controller.signal,
        onUsage: (e) => {
          // Recorded with the source it was spent on.
          base.onUsage?.({ ...e, sourceId: job.sourceId })
          if (!model.local) spentNow += e.cost
        },
      }
      let proposed = job.proposed
      const write = (questions: readonly DeckQuestion[], units: readonly number[]): void => {
        const drafts = toNewDrafts(questions, plan, content.units, modelName(model.info))
        if (drafts.length > 0) {
          ws.drafts.propose(drafts)
          proposed += drafts.length
        }
        for (const u of units) done.add(u)
        const p: Partial<AiJob> = {
          progress: { done: [...done].sort((a, b) => a - b), total },
          proposed,
          spent: job.spent + spentNow,
        }
        chain = chain.then(() => set(p))
      }
      input.onProgress = (progress, finished) =>
        write(
          finished.flatMap((u) => progress.done[u] ?? []),
          finished,
        )
      const res = await generator.generate(ctx, input)
      // An adapter that hands nothing out as it goes: what it returned for units not written yet.
      const rest = res.questions.filter((q) => !done.has(q.unit))
      if (rest.length > 0) write(rest, [...new Set(rest.map((q) => q.unit))])
      await chain
      await set({
        status: 'done',
        outcome: 'proposed',
        duplicates: job.duplicates + res.duplicates,
        spent: job.spent + spentNow,
        progress: { done: content.units.map((u) => u.index), total },
      })
    } catch (e) {
      // Drafts written so far stay; their progress is stored before deciding what happens next.
      await chain
      const why = abortOf(controller.signal)
      const spent = job.spent + spentNow
      if (why === 'cancel') await set({ spent })
      else if (why === 'stop') await set({ status: 'queued', spent })
      else if (!model.local && !network.online()) await set({ status: 'waiting', waitReason: 'offline', spent })
      else await set({ status: 'failed', spent, error: e instanceof Error ? e.message : String(e) })
    } finally {
      this.current = null
      this.publish({ running: null })
    }
  }
}

export function createJobs(deps: JobsDeps): AiJobs {
  return new JobQueue(deps)
}
