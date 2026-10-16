import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import * as Y from 'yjs'
import type { LocalStore } from '../contracts/ports'
import type { SourceRecord } from '../model/schema'
import { createWorkspace, type ModelWorkspace } from '../model/workspace'
import { virtualClock } from '../ports/clock'
import { memoryLocks } from '../ports/locks'
import { seededRng } from '../ports/rng'
import { memoryStore } from '../storage/memoryStore'
import type { QuestionGenerator, SourceContent } from './autoQuestions'
import type { CatalogModel } from './catalogTrim'
import type { DeckQuestionsInput } from './features/deckQuestions'
import type { DeckUnitInput } from './features/readDeck'
import {
  type AiJob,
  type AiJobs,
  createJobs,
  JOBS_KEY,
  type JobModel,
  type JobsDeps,
  KEEP_FINISHED,
  parseJobs,
} from './jobs'
import { INFO } from './testkit.test'
import type { AiUsageEvent } from './usage'

interface Q {
  unit: number
  type: 'qa' | 'cloze' | 'explain'
  difficulty: 'easy' | 'medium' | 'hard'
  front: string
  back: string
}

const tokens = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
})

/** Units a call was given, read from its prompt, with the title the harness put in each. */
function unitsOf(prompt: unknown): { n: number; title: string }[] {
  const text = JSON.stringify(prompt)
  return [...text.matchAll(/<<<UNIT n=\\"(\d+)\\"[^>]*>>>\\nTitle: ([^\\]+)/g)].map((m) => ({
    n: Number(m[1]),
    title: m[2] ?? '',
  }))
}

/** Three distinct questions per unit by default. */
const defaultAnswer = (units: { n: number; title: string }[]): Q[] =>
  units.flatMap((u) =>
    ['alpha', 'beta', 'gamma'].map((k) => ({
      unit: u.n,
      type: 'qa' as const,
      difficulty: 'easy' as const,
      front: `${u.title} question ${k}?`,
      back: `answer ${k}`,
    })),
  )

const ONLINE_INFO: CatalogModel = { ...INFO, context_length: 200_000, output_limit: 16_000 }

function harness(o: { model?: 'online' | 'local' | 'none'; online?: boolean; seed?: number } = {}) {
  const doc = new Y.Doc()
  const clock = virtualClock(1_700_000_000_000)
  const rng = seededRng(o.seed ?? 7, clock)
  const ws: ModelWorkspace = createWorkspace(doc, { rng, clock, deviceId: 'dev' })
  const store: LocalStore = memoryStore()
  const contents = new Map<string, SourceContent | null>()
  const usage: AiUsageEvent[] = []
  const h = {
    doc,
    clock,
    ws,
    store,
    usage,
    online: o.online ?? true,
    netListeners: [] as (() => void)[],
    modelKind: o.model ?? 'online',
    info: ONLINE_INFO,
    /** Tokens each call reports. */
    perCall: [100, 50] as [number, number],
    calls: [] as { units: { n: number; title: string }[] }[],
    inFlight: 0,
    maxInFlight: 0,
    answer: (units: { n: number; title: string }[], _call: number): Promise<Q[]> | Q[] => defaultAnswer(units),
    contentCalls: 0,
    contents,
    model: null as unknown as MockLanguageModelV4,
    deps: null as unknown as JobsDeps,
    jobs: null as unknown as AiJobs,
    courseId: '',
  }
  h.model = new MockLanguageModelV4({
    doGenerate: async ({ prompt, abortSignal }) => {
      const units = unitsOf(prompt)
      const call = h.calls.length
      h.calls.push({ units })
      h.inFlight++
      h.maxInFlight = Math.max(h.maxInFlight, h.inFlight)
      try {
        const questions = await Promise.race([
          Promise.resolve(h.answer(units, call)),
          new Promise<never>((_, reject) => {
            if (abortSignal?.aborted) reject(abortSignal.reason)
            abortSignal?.addEventListener('abort', () => reject(abortSignal.reason))
          }),
        ])
        return {
          content: [{ type: 'text', text: JSON.stringify({ questions }) }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: tokens(h.perCall[0], h.perCall[1]),
          warnings: [],
        }
      } finally {
        h.inFlight--
      }
    },
  })
  const jobModel = (): JobModel => ({
    info: h.modelKind === 'local' ? { ...h.info, provider: 'local', cost: undefined } : h.info,
    local: h.modelKind === 'local',
    context: async (signal, language) => ({
      model: h.model,
      info: h.modelKind === 'local' ? { ...h.info, provider: 'local', cost: undefined } : h.info,
      language,
      signal,
      onUsage: (e) => {
        usage.push(e)
        ws.aiUsage.record({ model: `${e.provider}/${e.model}`, inTok: e.inputTokens, outTok: e.outputTokens })
      },
      now: () => clock.now(),
    }),
  })
  h.deps = {
    ws,
    store,
    locks: memoryLocks(),
    clock,
    rng,
    network: {
      online: () => h.online,
      subscribe: (fn) => {
        h.netListeners.push(fn)
        return () => {
          h.netListeners = h.netListeners.filter((f) => f !== fn)
        }
      },
    },
    model: async () => (h.modelKind === 'none' ? null : jobModel()),
    content: async (source: SourceRecord) => {
      h.contentCalls++
      return contents.get(source.id) ?? null
    },
  }
  h.jobs = createJobs(h.deps)
  h.courseId = ws.courses.create({ title: 'Physiology' })
  return h
}
type H = ReturnType<typeof harness>

function units(title: string, n: number): DeckUnitInput[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    kind: 'slide' as const,
    label: String(i + 1),
    title: `${title} ${i + 1}`,
    text: `Some material about ${title} on slide ${i + 1}.`,
  }))
}

function source(h: H, title: string, n = 2, kind: SourceRecord['kind'] = 'pdf'): string {
  const id = h.ws.sources.create({ courseId: h.courseId, kind, title })
  h.contents.set(id, { title, units: units(title, n) })
  return id
}

const job = (h: H, id: string | null): AiJob => {
  const j = h.jobs.state().jobs.find((x) => x.id === id)
  if (!j) throw new Error(`no job ${id}`)
  return j
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return
    await Bun.sleep(1)
  }
  throw new Error(`never: ${what}`)
}

/** A promise the test resolves itself. */
function gate() {
  let open = () => {}
  const p = new Promise<void>((r) => {
    open = r
  })
  return { p, open }
}

async function stored(store: LocalStore): Promise<AiJob[]> {
  return parseJobs(await store.read(['kv'], (tx) => tx.get<unknown>('kv', JOBS_KEY)))
}

describe('auto-question jobs', () => {
  test('proposes drafts grouped by unit, in the course language, and counts them for Today', async () => {
    const h = harness()
    h.ws.courses.update(h.courseId, { language: 'de' })
    const s = source(h, 'Heart', 2)
    await h.jobs.start()
    const id = await h.jobs.enqueue(s)
    await h.jobs.idle()
    expect(job(h, id)).toMatchObject({
      status: 'done',
      outcome: 'proposed',
      proposed: 6,
      added: 0,
      progress: { done: [1, 2], total: 2 },
      model: 'mockai/mock-1',
    })
    expect(job(h, id).spent).toBeCloseTo(
      h.usage.reduce((n, e) => n + e.cost, 0),
      10,
    )
    const groups = h.ws.drafts.groups({ sourceId: s })
    expect(groups[0]?.units.map((u) => [u.unit, u.unitKind, u.unitLabel, u.drafts.length])).toEqual([
      [1, 'slide', '1', 3],
      [2, 'slide', '2', 3],
    ])
    expect(h.ws.drafts.list()[0]).toMatchObject({ sourceId: s, courseId: h.courseId, model: 'mockai/mock-1' })
    expect(h.ws.drafts.summary()).toMatchObject({ total: 6, sources: [{ sourceId: s, count: 6 }] })
    expect(h.ws.cards.all()).toEqual([])
    const call = h.model.doGenerateCalls[0]
    expect(JSON.stringify(call?.prompt)).toContain('in German')
    // Usage went to the workspace (synced), with the source it was spent on.
    expect(h.ws.aiUsage.list()).toHaveLength(1)
  })

  test('runs one source at a time, oldest first', async () => {
    const h = harness()
    const a = source(h, 'Alpha', 1)
    const b = source(h, 'Beta', 1)
    const c = source(h, 'Gamma', 1)
    const ids = [await h.jobs.enqueue(a), await h.jobs.enqueue(b), await h.jobs.enqueue(c)]
    expect(await h.jobs.enqueue(b)).toBe(ids[1] as string)
    expect(h.calls).toEqual([])
    expect((await stored(h.store)).map((j) => j.status)).toEqual(['queued', 'queued', 'queued'])
    await h.jobs.start()
    await h.jobs.idle()
    expect(h.calls.map((c) => c.units[0]?.title)).toEqual(['Alpha 1', 'Beta 1', 'Gamma 1'])
    expect(h.maxInFlight).toBe(1)
    expect(ids.map((id) => job(h, id).status)).toEqual(['done', 'done', 'done'])
  })

  test('what the student chose: only the units asked for, in the language and place asked for; same choices, same job', async () => {
    const h = harness()
    const s = source(h, 'Heart', 4)
    const sectionId = h.ws.sections.create({ courseId: h.courseId, name: 'Cardio' })
    const options = {
      units: [3, 2],
      perUnit: 1,
      types: ['qa' as const],
      difficulty: 'hard' as const,
      language: 'fr',
      sectionId,
    }
    const id = await h.jobs.enqueue(s, options)
    expect(await h.jobs.enqueue(s, { ...options, units: [2, 3] })).toBe(id)
    const other = await h.jobs.enqueue(s)
    expect(other).not.toBe(id)
    expect((await stored(h.store))[0]?.options).toEqual({ ...options, units: [2, 3] })
    const estimate = await h.jobs.estimate(s, options)
    expect(estimate).toMatchObject({ kind: 'ok', estimate: { units: 2 } })
    await h.jobs.cancel(other)
    await h.jobs.start()
    await h.jobs.idle()
    expect(h.calls.map((c) => c.units.map((u) => u.n))).toEqual([[2, 3]])
    expect(job(h, id)).toMatchObject({ status: 'done', progress: { done: [2, 3], total: 2 } })
    const prompt = JSON.stringify(h.model.doGenerateCalls[0]?.prompt)
    expect(prompt).toContain('in French')
    expect(new Set(h.ws.drafts.list().map((d) => d.sectionId))).toEqual(new Set([sectionId]))
    // Options this version cannot read fall back to the defaults.
    expect(
      parseJobs({ jobs: [{ ...job(h, id), options: { units: 'x', perUnit: 0, types: ['nope'], language: 1 } }] })[0],
    ).not.toHaveProperty('options')
  })

  test('resumes after the app is closed mid-run, without reading a unit twice', async () => {
    const h = harness()
    const s = source(h, 'Heart', 8)
    const g = gate()
    h.answer = async (us, call) => {
      if (call === 1) await g.p
      return defaultAnswer(us)
    }
    await h.jobs.start()
    const id = await h.jobs.enqueue(s)
    await until(() => h.calls.length === 2, 'second batch started')
    await until(() => job(h, id).progress.done.length === 6, 'first batch stored')
    // The process dies: nothing stops the run, nothing is cleaned up.
    expect((await stored(h.store))[0]).toMatchObject({ status: 'running', proposed: 18 })
    expect(h.ws.drafts.all()).toHaveLength(18)
    // A new process over the same device store and workspace.
    const restarted = createJobs({ ...h.deps, locks: memoryLocks() })
    h.answer = (us) => defaultAnswer(us)
    await restarted.start()
    await restarted.idle()
    const after = restarted.state().jobs.find((j) => j.id === id)
    expect(after).toMatchObject({
      status: 'done',
      proposed: 24,
      progress: { done: [1, 2, 3, 4, 5, 6, 7, 8], total: 8 },
    })
    expect(h.calls[2]?.units.map((u) => u.n)).toEqual([7, 8])
    expect(h.ws.drafts.all()).toHaveLength(24)
    g.open()
    await h.jobs.idle()
    // The old process's answer, arriving late, writes no draft twice.
    expect(new Set(h.ws.drafts.all().map((d) => d.front)).size).toBe(h.ws.drafts.all().length)
  })

  test('stop interrupts without cancelling: the job resumes on the next start', async () => {
    const h = harness()
    const s = source(h, 'Heart', 8)
    const g = gate()
    h.answer = async (us, call) => {
      if (call === 1) await g.p
      return defaultAnswer(us)
    }
    await h.jobs.start()
    const id = await h.jobs.enqueue(s)
    await until(() => h.calls.length === 2, 'second batch started')
    h.jobs.stop()
    await h.jobs.idle()
    expect(job(h, id)).toMatchObject({ status: 'queued', progress: { done: [1, 2, 3, 4, 5, 6] } })
    expect(await h.jobs.enqueue(source(h, 'Lungs', 1))).not.toBeNull()
    expect(h.calls).toHaveLength(2)
    h.answer = (us) => defaultAnswer(us)
    await h.jobs.start()
    await h.jobs.idle()
    expect(job(h, id).status).toBe('done')
    expect(h.calls.map((c) => c.units.map((u) => u.n))).toEqual([[1, 2, 3, 4, 5, 6], [7, 8], [7, 8], [1]])
  })

  test('cancel stops the running job, keeps its drafts, and moves on; a queued job never runs', async () => {
    const h = harness()
    const a = source(h, 'Heart', 8)
    const b = source(h, 'Lungs', 1)
    const c = source(h, 'Kidney', 1)
    const g = gate()
    h.answer = async (us, call) => {
      if (call === 1) await g.p
      return defaultAnswer(us)
    }
    await h.jobs.start()
    const ia = await h.jobs.enqueue(a)
    const ib = await h.jobs.enqueue(b)
    const ic = await h.jobs.enqueue(c)
    await until(() => h.calls.length === 2, 'second batch started')
    await h.jobs.cancel(ic as string)
    await h.jobs.cancel(ia as string)
    await h.jobs.idle()
    expect(job(h, ia)).toMatchObject({ status: 'cancelled', proposed: 18 })
    expect(job(h, ib).status).toBe('done')
    expect(job(h, ic).status).toBe('cancelled')
    expect(h.calls.map((x) => x.units[0]?.title)).toEqual(['Heart 1', 'Heart 7', 'Lungs 1'])
    expect(h.ws.drafts.list({ sourceId: a })).toHaveLength(18)
    await h.jobs.cancel(ia as string)
    expect(job(h, ia).status).toBe('cancelled')
    // Retrying resumes where it stopped.
    h.answer = (us) => defaultAnswer(us)
    await h.jobs.retry(ia as string)
    await h.jobs.idle()
    expect(job(h, ia)).toMatchObject({ status: 'done', proposed: 24 })
  })

  test('a job cancelled from another tab stops at its next step', async () => {
    const h = harness()
    const s = source(h, 'Heart', 14)
    const g = gate()
    const never = gate()
    h.answer = async (us, call) => {
      if (call === 1) await g.p
      if (call === 2) await never.p
      return defaultAnswer(us)
    }
    await h.jobs.start()
    const id = await h.jobs.enqueue(s)
    await until(() => h.calls.length === 2, 'second batch started')
    const other = createJobs(h.deps)
    await other.cancel(id as string)
    g.open()
    await h.jobs.idle()
    await h.jobs.refresh()
    expect(job(h, id)).toMatchObject({
      status: 'cancelled',
      progress: { done: [...Array(12).keys()].map((i) => i + 1) },
    })
    // The call started meanwhile was interrupted: its units were never written.
    expect(h.calls.length).toBeLessThanOrEqual(3)
    expect(h.ws.drafts.all()).toHaveLength(36)
  })

  test('offline: waits with a reason, then runs once back online; an on-device model needs no connection', async () => {
    const h = harness({ online: false })
    const s = source(h, 'Heart', 1)
    await h.jobs.start()
    const id = await h.jobs.enqueue(s)
    await h.jobs.idle()
    expect(job(h, id)).toMatchObject({ status: 'waiting', waitReason: 'offline' })
    expect(h.calls).toEqual([])
    h.online = true
    for (const fn of h.netListeners) fn()
    await until(() => job(h, id).status === 'done', 'ran once online')
    expect(job(h, id).waitReason).toBeUndefined()

    const local = harness({ online: false, model: 'local' })
    const ls = source(local, 'Heart', 1)
    await local.jobs.start()
    const lid = await local.jobs.enqueue(ls)
    await local.jobs.idle()
    expect(job(local, lid)).toMatchObject({ status: 'done', spent: 0, model: 'local/mock-1' })
  })

  test('a run that fails offline waits for the connection instead of failing', async () => {
    const h = harness()
    const s = source(h, 'Heart', 1)
    h.answer = () => {
      h.online = false
      throw new Error('network down')
    }
    await h.jobs.start()
    const id = await h.jobs.enqueue(s)
    await h.jobs.idle()
    expect(job(h, id)).toMatchObject({ status: 'waiting', waitReason: 'offline' })
  })

  test('never runs without a configured model', async () => {
    const h = harness({ model: 'none' })
    const s = source(h, 'Heart', 1)
    await h.jobs.start()
    const id = await h.jobs.enqueue(s)
    await h.jobs.idle()
    expect(job(h, id).status).toBe('needs-model')
    expect(h.contentCalls).toBe(0)
    expect(await h.jobs.estimate(s)).toEqual({ kind: 'needs-model' })
    h.modelKind = 'online'
    await h.jobs.kick()
    await h.jobs.idle()
    expect(job(h, id).status).toBe('done')
  })

  test('questions close to existing cards are dropped', async () => {
    const h = harness()
    const s = source(h, 'Heart', 1)
    const card = h.ws.cards.create({ courseId: h.courseId, kind: 'basic' })
    h.ws.text({ id: card, field: 'front' }).insert(0, 'Heart 1 question alpha?')
    await h.jobs.start()
    const id = await h.jobs.enqueue(s)
    await h.jobs.idle()
    expect(job(h, id)).toMatchObject({ status: 'done', proposed: 2, duplicates: 1 })
    expect(h.ws.drafts.all().map((d) => d.front)).not.toContain('Heart 1 question alpha?')
  })

  test('rejected questions are never proposed again, nor the ones already proposed', async () => {
    const h = harness()
    const s = source(h, 'Heart', 1)
    await h.jobs.start()
    const id = await h.jobs.enqueue(s)
    await h.jobs.idle()
    const rejected = h.ws.drafts.list().find((d) => d.front === 'Heart 1 question beta?')
    h.ws.drafts.reject(rejected?.id as string)
    // The same source again: nothing new (one rejected, two already proposed).
    await h.jobs.retry(id as string)
    await h.jobs.idle()
    expect(job(h, id)).toMatchObject({ status: 'done', proposed: 3, duplicates: 3 })
    expect(h.ws.drafts.all()).toHaveLength(3)
    // Another source asking the very same question: the rejection holds everywhere.
    const other = h.ws.sources.create({ courseId: h.courseId, kind: 'note', title: 'Copy' })
    h.contents.set(other, { units: units('Heart', 1) })
    const oid = await h.jobs.enqueue(other)
    await h.jobs.idle()
    expect(job(h, oid)).toMatchObject({ proposed: 2, duplicates: 1 })
    expect(h.ws.drafts.list({ sourceId: other }).map((d) => d.front)).not.toContain('Heart 1 question beta?')
  })

  test('a source trashed before its turn, or with nothing to read, finishes without a call', async () => {
    const h = harness()
    const gone = source(h, 'Heart', 1)
    const empty = h.ws.sources.create({ courseId: h.courseId, kind: 'note', title: 'Empty' })
    h.contents.set(empty, { units: [] })
    const unreadable = h.ws.sources.create({ courseId: h.courseId, kind: 'note', title: 'Unknown' })
    const a = await h.jobs.enqueue(gone)
    const b = await h.jobs.enqueue(empty)
    const c = await h.jobs.enqueue(unreadable)
    h.ws.sources.trash(gone)
    await h.jobs.start()
    await h.jobs.idle()
    expect(job(h, a)).toMatchObject({ status: 'done', outcome: 'source-gone' })
    expect(job(h, b)).toMatchObject({ status: 'done', outcome: 'empty' })
    expect(job(h, c)).toMatchObject({ status: 'done', outcome: 'empty' })
    expect(h.calls).toEqual([])
    expect(await h.jobs.estimate(gone)).toEqual({ kind: 'source-gone' })
    expect(await h.jobs.estimate(empty)).toEqual({ kind: 'empty' })
  })

  test('a failed run says why and can be retried', async () => {
    const h = harness()
    const s = source(h, 'Heart', 1)
    h.answer = () => {
      throw new Error('provider exploded')
    }
    await h.jobs.start()
    const id = await h.jobs.enqueue(s)
    await h.jobs.idle()
    expect(job(h, id).status).toBe('failed')
    expect(job(h, id).error).toContain('provider exploded')
    h.answer = (us) => defaultAnswer(us)
    await h.jobs.retry(id as string)
    await h.jobs.idle()
    expect(job(h, id)).toMatchObject({ status: 'done', proposed: 3 })
    expect(job(h, id).error).toBeUndefined()
  })

  test('only the student starts a job: what an earlier version queued on its own, or held by a cost cap, is cancelled', async () => {
    const h = harness()
    const added = source(h, 'Added', 1)
    const capped = source(h, 'Capped', 1)
    const now = h.clock.now()
    const base = {
      createdAt: now,
      updatedAt: now,
      spent: 0,
      progress: { done: [], total: 0 },
      proposed: 0,
      added: 0,
      duplicates: 0,
    }
    await h.store.commit([
      {
        put: 'kv',
        key: JOBS_KEY,
        value: {
          v: 1,
          jobs: [
            { ...base, id: 'a', sourceId: added, reason: 'added', status: 'queued' },
            {
              ...base,
              id: 'c',
              sourceId: capped,
              reason: 'manual',
              status: 'over-cap',
              cap: { scope: 'month', limit: 2, spent: 2 },
              approved: 1,
            },
          ],
        },
      },
    ])
    await h.jobs.start()
    await h.jobs.idle()
    expect(h.calls).toEqual([])
    expect(job(h, 'a')).toMatchObject({ status: 'cancelled', reason: 'added' })
    expect(job(h, 'c')).toMatchObject({ status: 'cancelled' })
    expect(Object.keys(job(h, 'c'))).not.toContain('cap')
    expect(Object.keys(job(h, 'c'))).not.toContain('approved')
    expect(await stored(h.store)).toMatchObject([{ status: 'cancelled' }, { status: 'cancelled' }])
    // Asked for again, it runs, as the student's own.
    await h.jobs.retry('a')
    await h.jobs.idle()
    expect(job(h, 'a')).toMatchObject({ status: 'done', reason: 'manual', proposed: 3 })
  })

  test('an adapter generates for its source kind (photos), handing questions out at the end', async () => {
    const h = harness()
    const photo = source(h, 'Photo', 1, 'image')
    const seen: DeckQuestionsInput[] = []
    const photos: QuestionGenerator = {
      estimate: () => ({ cost: 0.001, calls: 1, units: 1 }),
      generate: async (_ctx, input) => {
        seen.push(input)
        return {
          questions: [
            {
              kind: 'basic',
              type: 'qa',
              difficulty: 'easy',
              front: 'What does the photo show?',
              back: 'A heart',
              unit: 1,
              sourceRef: { sourceId: input.sourceId },
            },
          ],
          duplicates: 0,
        }
      },
    }
    const jobs = createJobs({ ...h.deps, generators: { image: photos } })
    await jobs.start()
    const id = await jobs.enqueue(photo)
    await jobs.idle()
    expect(jobs.state().jobs.find((j) => j.id === id)).toMatchObject({ status: 'done', proposed: 1 })
    expect(seen[0]?.sourceId).toBe(photo)
    expect(h.ws.drafts.list()[0]).toMatchObject({ front: 'What does the photo show?', unitKind: 'slide' })
    expect(h.calls).toEqual([])
  })

  test('the stored queue keeps every active job and the latest finished ones; bad entries are ignored', async () => {
    const h = harness()
    const ids: string[] = []
    for (let i = 0; i < KEEP_FINISHED + 3; i++) {
      h.clock.advance(1000)
      ids.push((await h.jobs.enqueue(source(h, `S${i}`, 1))) as string)
    }
    await h.jobs.start()
    await h.jobs.idle()
    const kept = await stored(h.store)
    expect(kept).toHaveLength(KEEP_FINISHED)
    expect(kept.map((j) => j.id)).toEqual(ids.slice(3))
    expect(parseJobs(null)).toEqual([])
    expect(parseJobs({ jobs: 'nope' })).toEqual([])
    expect(parseJobs({ v: 1, jobs: [{ id: 'x' }, kept[0], 3, null] })).toEqual([kept[0] as AiJob])
    // Another instance (another tab, a restart) reads the same queue.
    const other = createJobs(h.deps)
    expect(other.state().loaded).toBe(false)
    await other.refresh()
    expect(other.state()).toMatchObject({ loaded: true, running: null })
    expect(other.state().jobs).toHaveLength(KEEP_FINISHED)
  })

  test('subscribers see every change; a store that refuses writes stops the queue and says why', async () => {
    const h = harness()
    const s = source(h, 'Heart', 1)
    const statuses: string[] = []
    const off = h.jobs.subscribe((st) => {
      const j = st.jobs[0]
      if (j && statuses.at(-1) !== j.status) statuses.push(j.status)
    })
    await h.jobs.start()
    await h.jobs.enqueue(s)
    await h.jobs.idle()
    off()
    expect(statuses).toEqual(['queued', 'running', 'done'])

    const broken = harness()
    let refuse = false
    const store: LocalStore = {
      read: (stores, fn) => broken.store.read(stores, fn),
      commit: async (ops) => {
        if (refuse) throw new Error('quota exceeded')
        return broken.store.commit(ops)
      },
    }
    const jobs = createJobs({ ...broken.deps, store })
    await jobs.enqueue(source(broken, 'Heart', 1))
    refuse = true
    await jobs.start()
    await jobs.idle()
    expect(jobs.state().error).toBe('quota exceeded')
    expect(broken.calls).toEqual([])
  })
})
