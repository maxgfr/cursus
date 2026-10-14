import fc from 'fast-check'
import { RemoteError } from '../../src/core/contracts/errors'
import type { Rating } from '../../src/core/contracts/workspace'
import { createSealer, sealDestination } from '../../src/core/crypto/sealer'
import { blobRef } from '../../src/core/log/blobs'
import { memoryStore } from '../../src/core/storage/memoryStore'
import type { Fault } from '../../src/core/sync/providers/faulty'
import { memoryRemote } from '../../src/core/sync/providers/memory'
import { checkContinuous, checkFinal, snapshotMovement } from './invariants'
import { CrashError, type SimDevice, type SimParams, type SimTab, World } from './world'

const MIN = 60 * 1000
export const MAX_ACTIONS = 40
export const MAX_HEAL_PASSES = 8

type Field = 'body' | 'front' | 'back'

export type Action =
  | { t: 'course'; dev: number; tab: number }
  | { t: 'card'; dev: number; tab: number; course: number }
  | { t: 'source'; dev: number; tab: number; course: number }
  | { t: 'text'; dev: number; tab: number; target: number; pos: number }
  | { t: 'untext'; dev: number; tab: number; target: number; which: number }
  | { t: 'trash' | 'restore' | 'purge'; dev: number; tab: number; target: number }
  | { t: 'move'; dev: number; tab: number; card: number; course: number }
  | { t: 'review'; dev: number; tab: number; card: number; rating: Rating }
  | { t: 'void'; dev: number; tab: number; which: number }
  | { t: 'attach'; dev: number; tab: number; size: number }
  | { t: 'seal' | 'compact' | 'clone' | 'flush'; dev: number }
  | { t: 'round' | 'verify' | 'unlock'; dev: number; dest: number }
  | { t: 'crash'; dev: number; after: number }
  | { t: 'fresh'; links: number; unhinted?: boolean; blackout?: number }
  | { t: 'partition' | 'auth'; dev: number; dest: number; on: boolean }
  | { t: 'fault'; dev: number; dest: number; kind: Fault; n: number }
  | { t: 'skew'; dev: number; ms: number }
  | { t: 'lossy'; dev: number; on: boolean }
  | { t: 'tabsync'; dev: number; tab: number }
  | { t: 'sealDest'; dest: number; locked: number; unhinted?: number; blackout?: number }
  | { t: 'advance'; ms: number }
  | { t: 'localQuota'; dev: number; n: number }

const ix = fc.nat({ max: 50 })
const FAULTS: Fault[] = [
  'put-before',
  'put-after',
  'put-lost',
  'put-corrupt',
  'get-corrupt',
  'get-fail',
  'list-fail',
  'list-omit',
  'list-dup',
  'rate-limit',
  'auth',
  'quota',
]

export const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant('course' as const), dev: ix, tab: ix }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('card' as const), dev: ix, tab: ix, course: ix }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('source' as const), dev: ix, tab: ix, course: ix }) },
  { weight: 8, arbitrary: fc.record({ t: fc.constant('text' as const), dev: ix, tab: ix, target: ix, pos: ix }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('untext' as const), dev: ix, tab: ix, target: ix, which: ix }) },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constantFrom('trash' as const, 'restore' as const, 'purge' as const),
      dev: ix,
      tab: ix,
      target: ix,
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('move' as const), dev: ix, tab: ix, card: ix, course: ix }) },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('review' as const),
      dev: ix,
      tab: ix,
      card: ix,
      rating: fc.constantFrom<Rating>(1, 2, 3, 4),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('void' as const), dev: ix, tab: ix, which: ix }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('attach' as const),
      dev: ix,
      tab: ix,
      size: fc.integer({ min: 0, max: 300 }),
    }),
  },
  { weight: 6, arbitrary: fc.record({ t: fc.constant('seal' as const), dev: ix }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('compact' as const), dev: ix }) },
  { weight: 8, arbitrary: fc.record({ t: fc.constant('round' as const), dev: ix, dest: ix }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('verify' as const), dev: ix, dest: ix }) },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('crash' as const), dev: ix, after: fc.integer({ min: 1, max: 6 }) }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('clone' as const), dev: ix }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('fresh' as const), links: fc.integer({ min: 1, max: 15 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('partition' as const), dev: ix, dest: ix, on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('auth' as const), dev: ix, dest: ix, on: fc.boolean() }) },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('fault' as const),
      dev: ix,
      dest: ix,
      kind: fc.constantFrom(...FAULTS),
      n: fc.integer({ min: 1, max: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('skew' as const),
      dev: ix,
      ms: fc.integer({ min: -60 * MIN, max: 60 * MIN }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('lossy' as const), dev: ix, on: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('tabsync' as const), dev: ix, tab: ix }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('flush' as const), dev: ix }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('sealDest' as const), dest: ix, locked: fc.nat({ max: 7 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('unlock' as const), dev: ix, dest: ix }) },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant('advance' as const), ms: fc.integer({ min: 1000, max: 12 * MIN }) }),
  },
)

/**
 * Faults beyond the original model, kept out of `actionArb` so the pinned regressions replay exactly:
 * - localQuota: the next N local appends fail (the device is out of storage), then storage frees up;
 * - sealed destinations added WITHOUT the `sealed` hint (per device bit), by a seal or a fresh device,
 *   whose first listings may lose pages (`blackout`: that many pages silently missing);
 * - listing blackouts: every page of the next listings silently missing (whole `keys/` pages lost).
 */
export const extendedActionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 90, arbitrary: actionArb },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('fault' as const),
      dev: ix,
      dest: ix,
      kind: fc.constant<Fault>('list-omit'),
      n: fc.integer({ min: 4, max: 12 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('localQuota' as const), dev: ix, n: fc.integer({ min: 1, max: 4 }) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('sealDest' as const),
      dest: ix,
      locked: fc.nat({ max: 7 }),
      unhinted: fc.integer({ min: 1, max: 15 }),
      blackout: fc.nat({ max: 12 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('fresh' as const),
      links: fc.integer({ min: 1, max: 15 }),
      unhinted: fc.constant(true),
      blackout: fc.nat({ max: 12 }),
    }),
  },
)

export const paramsArb: fc.Arbitrary<SimParams> = fc
  .record({
    seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
    devices: fc.integer({ min: 2, max: 4 }),
    dests: fc.integer({ min: 1, max: 3 }),
    links: fc.array(fc.integer({ min: 0, max: 7 }), { minLength: 4, maxLength: 4 }),
    tabs: fc.array(fc.integer({ min: 1, max: 2 }), { minLength: 4, maxLength: 4 }),
    pageSize: fc.integer({ min: 1, max: 4 }),
    checkpointEvery: fc.integer({ min: 2, max: 6 }),
  })
  .map(({ devices, links, tabs, ...rest }) => ({
    ...rest,
    links: links.slice(0, devices),
    tabs: tabs.slice(0, devices),
  }))

/** Steps of 1 to 3 concurrent actions, at most 40 actions in all. */
const stepsOf = (action: fc.Arbitrary<Action>): fc.Arbitrary<Action[][]> =>
  fc
    .array(fc.array(action, { minLength: 1, maxLength: 3 }), { minLength: 4, maxLength: 20, size: 'max' })
    .map((steps) => {
      const out: Action[][] = []
      let n = 0
      for (const s of steps) {
        if (n >= MAX_ACTIONS) break
        const step = s.slice(0, MAX_ACTIONS - n)
        n += step.length
        out.push(step)
      }
      return out
    })
export const stepsArb: fc.Arbitrary<Action[][]> = stepsOf(actionArb)

export interface Simulation {
  params: SimParams
  steps: Action[][]
  scheduler: fc.Scheduler
}

export const simulationArb: fc.Arbitrary<Simulation> = fc.record({
  params: paramsArb,
  steps: stepsArb,
  scheduler: fc.scheduler(),
})

/** The invariant suite's simulation: every original action plus the extended faults. */
export const extendedSimulationArb: fc.Arbitrary<Simulation> = fc.record({
  params: paramsArb,
  steps: stepsOf(extendedActionArb),
  scheduler: fc.scheduler(),
})

const pick = <T>(xs: readonly T[], i: number): T | undefined => (xs.length === 0 ? undefined : xs[i % xs.length])

function textRefs(tab: SimTab): { id: string; field: Field }[] {
  const refs: { id: string; field: Field }[] = []
  for (const c of [...tab.ws.cards.list(), ...tab.ws.cards.list({ trashed: true })]) {
    refs.push({ id: c.id, field: 'front' }, { id: c.id, field: 'back' })
  }
  for (const s of [...tab.ws.sources.list(), ...tab.ws.sources.list({ trashed: true })])
    refs.push({ id: s.id, field: 'body' })
  return refs.sort((a, b) => (a.id + a.field < b.id + b.field ? -1 : 1))
}

function entities(tab: SimTab) {
  const all = <T extends { id: string }>(r: { list(f?: { trashed?: boolean }): readonly T[] }) => [
    ...r.list(),
    ...r.list({ trashed: true }),
  ]
  return [
    ...all(tab.ws.courses).map((e) => ({ repo: tab.ws.courses, id: e.id })),
    ...all(tab.ws.cards).map((e) => ({ repo: tab.ws.cards, id: e.id })),
    ...all(tab.ws.sources).map((e) => ({ repo: tab.ws.sources, id: e.id })),
  ]
}

/**
 * Performs a local edit and records it in the oracle once the log acknowledged it — maybe only after
 * retries (local quota), never if the process died first. Waits until the capture settles.
 */
async function edit(tab: SimTab, fn: () => (() => void) | null): Promise<void> {
  const before = tab.lastWrite
  const onAck = fn()
  const p = tab.lastWrite
  if (onAck === null || p === before || p === null) return
  tab.whenAcked(p, onAck)
  await tab.capture.settled()
}

function courseOf(tab: SimTab, i: number, w: World): string {
  const c = pick(tab.ws.courses.list(), i)
  if (c) return c.id
  const title = w.oracle.token('c')
  let id = ''
  tab.ws.batch(() => {
    id = tab.ws.courses.create({ title })
  })
  return id
}

async function runAction(w: World, a: Action): Promise<void> {
  const o = w.oracle
  const devs = w.devices
  if (a.t === 'advance') {
    w.clock.advance(a.ms)
    return
  }
  if (a.t === 'fresh') {
    if (devs.length >= 4) return
    const names = w.destList.filter((d, i) => d.ready && (a.links >> i) & 1).map((d) => d.name)
    const chosen = names.length > 0 ? names : ['d0']
    const unhinted = a.unhinted === true ? chosen.filter((n) => w.dest(n).sealed) : []
    const dev = await w.addDevice(memoryStore(), 1, chosen, unhinted)
    for (const d of unhinted) if (a.blackout) dev.faultsFor(d).inject('list-omit', a.blackout)
    for (const d of dev.dests) await unlockFor(w, dev, d)
    return
  }
  if (a.t === 'sealDest') {
    if (w.sealedCount >= 1) return
    const src = pick(
      w.destList.filter((d) => !d.sealed && d.ready),
      a.dest,
    )
    if (!src) return
    const owner = devs.find((d) => d.dests.has(src.name) && !d.dead)
    if (!owner) return
    w.sealedCount++
    const name = `s${w.sealedCount}`
    const passphrase = `pass ${w.params.seed}`
    const sim = { name, prefix: `${src.prefix}-sealed`, sealed: true, ready: false, passphrase }
    w.destList.push(sim)
    try {
      const ring = owner.keyringFor(name)
      const keyFile = await ring.create(passphrase)
      Object.assign(sim, { keyFile })
      await sealDestination({
        source: owner.faultsFor(src.name),
        target: memoryRemote({ bucket: w.bucket, prefix: sim.prefix }),
        keyring: ring,
        sealer: createSealer(w.rng),
        keyFile,
        pageSize: w.params.pageSize,
      })
    } catch (e) {
      // Sealing did not complete: the new root is never adopted (it only holds sealed objects).
      owner.keyrings.delete(name)
      throw e
    }
    sim.ready = true
    for (const [i, dev] of devs.entries()) {
      if (!dev.dests.has(src.name) || dev.dests.has(name) || dev.dead) continue
      const hinted = a.unhinted === undefined || ((a.unhinted >> i) & 1) === 0
      dev.addDest(name, hinted)
      if (!hinted && a.blackout) dev.faultsFor(name).inject('list-omit', a.blackout)
      if (dev !== owner && !((a.locked >> i) & 1)) await unlockFor(w, dev, name)
    }
    return
  }
  const dev = pick(devs, a.dev)
  if (!dev) return
  const destNames = [...dev.dests].sort()
  switch (a.t) {
    case 'seal': {
      const rec = await dev.log.seal()
      if (rec) dev.hint(rec.arrival)
      return
    }
    case 'flush':
      await dev.flushWrites()
      return
    case 'compact':
      await dev.log.compact()
      await dev.engine.checkpoint()
      return
    case 'round': {
      const d = pick(destNames, a.dest)
      if (d) await dev.engine.round(d)
      return
    }
    case 'verify': {
      const d = pick(destNames, a.dest)
      if (d) await dev.engine.verify(d)
      return
    }
    case 'crash':
      dev.crashIn = a.after
      return
    case 'clone': {
      if (devs.length >= 4 || dev.dead) return
      const copy = await World.copyStore(dev.base)
      await w.addDevice(copy, 1, dev.dests, dev.unhinted)
      return
    }
    case 'partition':
    case 'auth': {
      const d = pick(destNames, a.dest)
      if (!d) return
      const f = dev.faultsFor(d)
      if (a.t === 'partition') f.offline = a.on
      else f.authExpired = a.on
      return
    }
    case 'fault': {
      const d = pick(destNames, a.dest)
      if (d) dev.faultsFor(d).inject(a.kind, a.n)
      return
    }
    case 'skew':
      dev.offset = a.ms
      return
    case 'lossy':
      dev.lossy = a.on
      return
    case 'localQuota':
      dev.localQuota += a.n
      return
    case 'unlock': {
      const d = pick(destNames, a.dest)
      if (d) await unlockFor(w, dev, d)
      return
    }
    default:
      break
  }
  const tab = pick(dev.tabs, a.tab)
  if (!tab) return
  switch (a.t) {
    case 'tabsync':
      await tab.sync()
      return
    case 'course': {
      const title = o.token('c')
      await edit(tab, () => {
        const id = tab.ws.courses.create({ title })
        return () => o.courses.set(id, title)
      })
      return
    }
    case 'card':
    case 'source': {
      const course = courseOf(tab, a.course, w)
      const tok = o.token('k')
      await edit(tab, () => {
        let ref: { id: string; field: Field }
        tab.ws.batch(() => {
          const id =
            a.t === 'card'
              ? tab.ws.cards.create({ courseId: course, kind: 'basic' })
              : tab.ws.sources.create({ courseId: course, kind: 'note', title: 'n' })
          ref = { id, field: a.t === 'card' ? 'front' : 'body' }
          tab.ws.text(ref).insert(0, `${tok} `)
        })
        return () => o.tokens.set(tok, ref)
      })
      return
    }
    case 'text': {
      const ref = pick(textRefs(tab), a.target)
      if (!ref) return
      const t = tab.ws.text(ref)
      const s = t.toString()
      const bounds = [0, ...[...s].flatMap((ch, i) => (ch === ' ' ? [i + 1] : []))]
      const at = bounds[a.pos % bounds.length] ?? 0
      const tok = o.token('k')
      await edit(tab, () => {
        t.insert(at, `${tok} `)
        return () => o.tokens.set(tok, ref)
      })
      return
    }
    case 'untext': {
      const ref = pick(textRefs(tab), a.target)
      if (!ref) return
      const t = tab.ws.text(ref)
      const s = t.toString()
      const toks = s.split(' ').filter((x) => x.length > 0)
      const tok = pick(toks, a.which)
      if (!tok) return
      let at = -1
      for (let i = s.indexOf(`${tok} `); i >= 0; i = s.indexOf(`${tok} `, i + 1)) {
        if (i === 0 || s[i - 1] === ' ') {
          at = i
          break
        }
      }
      if (at < 0) return
      await edit(tab, () => {
        t.delete(at, tok.length + 1)
        return () => o.deleted.add(tok)
      })
      return
    }
    case 'trash':
    case 'restore':
    case 'purge': {
      const e = pick(entities(tab), a.target)
      if (!e) return
      await edit(tab, () => {
        e.repo[a.t](e.id)
        return () => {}
      })
      return
    }
    case 'move': {
      const card = pick(tab.ws.cards.list(), a.card)
      const course = pick(tab.ws.courses.list(), a.course)
      if (!card || !course) return
      await edit(tab, () => {
        tab.ws.cards.move(card.id, course.id)
        return () => {}
      })
      return
    }
    case 'review': {
      const card = pick(tab.ws.cards.list(), a.card)
      if (!card) return
      await edit(tab, () => {
        const id = tab.ws.reviews.record({ cardId: card.id, rating: a.rating, at: dev.clock.now(), ms: 1500 })
        return () => o.reviews.set(id, card.id)
      })
      return
    }
    case 'void': {
      const known = [...o.reviews.keys()].filter((id) => tab.ws.reviews.yArray.toArray().some((r) => r.id === id))
      const id = pick(known.sort(), a.which)
      if (!id) return
      await edit(tab, () => {
        tab.ws.reviews.void(id)
        return () => o.voids.add(id)
      })
      return
    }
    case 'attach': {
      const data = Uint8Array.from({ length: a.size }, () => w.rng.u32() & 0xff)
      const id = await dev.blobs.put(data, 'application/pdf')
      const course = courseOf(tab, 0, w)
      await edit(tab, () => {
        const sid = tab.ws.sources.create({ courseId: course, kind: 'pdf', title: 'file', blobId: blobRef(id) })
        return () => o.files.set(sid, id)
      })
      return
    }
  }
}

export async function unlockFor(w: World, dev: SimDevice, dest: string): Promise<void> {
  const d = w.dest(dest)
  if (!d.sealed || !d.keyFile || !d.passphrase) return
  const ring = dev.keyringFor(dest)
  await ring.learn([d.keyFile])
  await ring.unlock(d.passphrase)
}

/** Expected failures are absorbed (the engine already recorded them in its status); anything else fails. */
async function guarded(w: World, a: Action): Promise<void> {
  try {
    await runAction(w, a)
  } catch (e) {
    if (e instanceof RemoteError || e instanceof CrashError) w.absorbed++
    else throw e
  }
}

/** Lifts every fault, then rounds + verify until a whole pass moves nothing (at most 8 passes). */
export async function heal(w: World): Promise<number> {
  w.scheduler = null
  for (const dev of w.devices) {
    if (dev.dead) await dev.boot()
    dev.crashIn = null
    dev.localQuota = 0
    for (const f of dev.faults.values()) f.heal()
    dev.lossy = false
    for (const d of dev.dests) await unlockFor(w, dev, d)
  }
  for (let pass = 1; pass <= MAX_HEAL_PASSES; pass++) {
    const before = await snapshotMovement(w)
    // Rewrites (a damaged marker or key file put back) move nothing countable: count what was sent too.
    let repaired = 0
    for (const dev of w.devices) {
      await dev.flushWrites()
      const rec = await dev.log.seal()
      if (rec) dev.hint(rec.arrival)
      for (const d of [...dev.dests].sort()) {
        repaired += (await dev.engine.round(d)).up
        repaired += (await dev.engine.verify(d)).repaired
      }
    }
    w.clock.advance(11 * MIN)
    const after = await snapshotMovement(w)
    if (repaired === 0 && before === after) {
      for (const dev of w.devices) for (const t of dev.tabs) await t.sync()
      return pass
    }
  }
  throw new Error(`heal: still moving objects after ${MAX_HEAL_PASSES} passes`)
}

export async function simulate(sim: Simulation): Promise<{ world: World; passes: number }> {
  const w = await World.create(sim.params)
  await checkContinuous(w)
  for (const step of sim.steps) {
    w.scheduler = sim.scheduler
    const all = Promise.all(step.map((a) => guarded(w, a)))
    await sim.scheduler.waitFor(all)
    await sim.scheduler.waitIdle()
    w.scheduler = null
    for (const dev of w.devices) {
      await dev.flushWrites()
      if (dev.dead) await dev.boot()
    }
    if (w.errors.length > 0) throw w.errors[0]
    await checkContinuous(w)
  }
  const passes = await heal(w)
  if (w.errors.length > 0) throw w.errors[0]
  await checkFinal(w)
  return { world: w, passes }
}
