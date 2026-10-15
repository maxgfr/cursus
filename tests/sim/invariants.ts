import * as Y from 'yjs'
import type { Key } from '../../src/core/contracts/remote'
import type { Review } from '../../src/core/contracts/workspace'
import { createSealer, isSealed } from '../../src/core/crypto/sealer'
import { parseManifest } from '../../src/core/log/blobs'
import { blobKey, bmanKey, codec, parseKey } from '../../src/core/log/codec'
import type { SegmentRow } from '../../src/core/log/localLog'
import { reviewEvents } from '../../src/core/model/reviews'
import { textKey } from '../../src/core/model/schema'
import { sessionHistory } from '../../src/core/model/sessions'
import type { ModelWorkspace } from '../../src/core/model/workspace'
import { seededRng } from '../../src/core/ports/rng'
import { createScheduler } from '../../src/core/srs/fsrs'
import { activitySplit } from '../../src/core/srs/stats'
import { canonicalJson, hashMatches } from '../../src/core/sync/verify'
import type { SimDevice, World } from './world'

export class InvariantError extends Error {
  constructor(
    readonly id: string,
    m: string,
  ) {
    super(`${id}: ${m}`)
    this.name = 'InvariantError'
  }
}

function check(cond: boolean, id: string, m: () => string): asserts cond {
  if (!cond) throw new InvariantError(id, m())
}

const history = new WeakMap<World, { buckets: Map<string, Set<Key>>; local: Map<string, Set<Key>> }>()

const isDataKey = (k: Key): boolean => {
  const kind = parseKey(k)?.kind
  return kind === 'seg' || kind === 'ckpt' || kind === 'blob' || kind === 'bman'
}

/** Keys of a registered destination, relative to its root. */
function bucketKeys(w: World, prefix: string): Set<Key> {
  return new Set(w.bucket.keys(`${prefix}/`).map((k) => k.slice(prefix.length + 1)))
}

/** What every device knows about objects: blob refs of log objects and chunks of manifests. */
async function registry(
  w: World,
): Promise<{ refs: Map<Key, string[]>; chunks: Map<Key, Key[]>; rows: Map<Key, Uint8Array> }> {
  const refs = new Map<Key, string[]>()
  const chunks = new Map<Key, Key[]>()
  const rows = new Map<Key, Uint8Array>()
  for (const dev of w.devices) {
    const [segs, bmanKeys, bmans] = await dev.base.read(['segments', 'bmans'], (tx) =>
      Promise.all([tx.getAll<SegmentRow>('segments'), tx.getAllKeys('bmans'), tx.getAll<Uint8Array>('bmans')]),
    )
    for (const r of segs) {
      refs.set(r.key, r.header.blobRefs)
      rows.set(r.key, r.bytes)
    }
    bmanKeys.forEach((k, i) => {
      const bytes = bmans[i]
      if (bytes) chunks.set(String(k), [...new Set(parseManifest(bytes).chunks)].map(blobKey))
    })
  }
  return { refs, chunks, rows }
}

const ITEM_KINDS = ['sources', 'fiches', 'cards'] as const

/**
 * I12 (one tab): the derived section tree is acyclic, links only sections of the same course, and every item
 * resolves to its root or to a live (not purged) section of its own course. Once converged (`settled`), every
 * item's course exists too — before that, a tab may hold an update whose dependencies have not arrived yet
 * (Yjs keeps it pending), so a field replaced elsewhere can be briefly missing.
 */
function checkTree(ws: ModelWorkspace, where: string, settled: boolean): void {
  const tree = ws.sections.tree()
  const all = tree.ids()
  for (const id of all) {
    let cur: string | null = id
    for (let steps = 0; cur !== null; steps++) {
      check(steps <= all.length, 'I12', () => `${where}: section ${id} sits on a cycle`)
      const p: string | null = tree.parent(cur)
      if (p !== null) {
        check(tree.get(p)?.courseId === tree.get(cur)?.courseId, 'I12', () => `${where}: ${cur} under another course`)
      }
      cur = p
    }
  }
  const courses = ws.doc.getMap<Y.Map<unknown>>('courses')
  for (const kind of ITEM_KINDS) {
    for (const e of ws[kind].all()) {
      if (settled) {
        check(courses.has(e.courseId), 'I12', () => `${where}: ${kind} ${e.id} in unknown course ${e.courseId}`)
      }
      const s = tree.sectionOf(e)
      if (s !== null) {
        const sec = tree.get(s)
        check(sec !== undefined && sec.purgedAt === undefined, 'I12', () => `${where}: ${e.id} in a purged section`)
        check(sec?.courseId === e.courseId, 'I12', () => `${where}: ${e.id} in a section of another course`)
      }
    }
  }
}

/** Everything a tab derives from the tree: effective parents, derived trash, where each item resolves. */
function treeSignature(ws: ModelWorkspace): string {
  const tree = ws.sections.tree()
  const rows = tree.ids().map((id) => `${id}<${tree.parent(id) ?? '-'}${tree.hidden(id) ? '!' : ''}`)
  for (const kind of ITEM_KINDS) {
    for (const e of ws[kind].all()) rows.push(`${e.id}@${tree.sectionOf(e) ?? '-'}${tree.itemHidden(e) ? '!' : ''}`)
  }
  return rows.sort().join('|')
}

/** I13 (converged): every acknowledged session, end, plan and practice review is there, as it was written. */
function checkSessions(w: World, ws: ModelWorkspace): void {
  const o = w.oracle
  for (const [id, s] of o.sessions) {
    const got = ws.sessions.get(id)
    check(got?.kind === s.kind && got.practice === s.practice, 'I13', () => `session ${id} lost or changed`)
    if (o.ended.has(id)) check(got.endedAt !== undefined, 'I13', () => `session ${id} no longer ended`)
  }
  const plans = new Set(ws.plans.all().map((p) => p.id))
  for (const id of o.plans.keys()) check(plans.has(id), 'I13', () => `plan ${id} lost`)
  const log = new Map(ws.reviews.yArray.toArray().map((r) => [r.id, r]))
  for (const [id, sid] of o.practice) {
    const r = log.get(id)
    check(
      r !== undefined && 'p' in r && r.p === true && r.sid === sid,
      'I13',
      () => `practice review ${id} lost its tags`,
    )
  }
}

/**
 * I13 (one tab): practice reviews never move the schedule — every card's FSRS state equals its replay with them
 * removed from the log — yet they count in the statistics, apart.
 */
function checkPractice(ws: ModelWorkspace, where: string): void {
  const log = ws.reviews.yArray.toArray()
  const practice = new Set(log.filter((r) => 'p' in r && r.p === true).map((r) => r.id))
  const withoutPractice: Review[] = log.filter((r) => !practice.has(r.id))
  const sch = createScheduler()
  const fresh = createScheduler({ maximumInterval: 36_499 })
  const states = sch.replayAll(log)
  check(
    JSON.stringify([...states]) === JSON.stringify([...fresh.replayAll(withoutPractice)]),
    'I13',
    () => `${where}: practice reviews moved the schedule`,
  )
  for (const card of ws.cards.all()) {
    const mine = ws.reviews.forCard(card.id)
    const a = sch.replay(card.id, mine)
    const b = fresh.replay(
      card.id,
      mine.filter((r) => !practice.has(r.id)),
    )
    check(JSON.stringify(a) === JSON.stringify(b), 'I13', () => `${where}: card ${card.id} moved by practice`)
  }
  const all = ws.reviews.all()
  const days = activitySplit(all, 0)
  const total = days.reduce((n, d) => n + d.reviews, 0)
  const crammed = days.reduce((n, d) => n + d.practice, 0)
  check(total === all.length, 'I13', () => `${where}: statistics count ${total} reviews of ${all.length}`)
  check(
    crammed === all.filter((r) => r.p === true).length,
    'I13',
    () => `${where}: statistics count ${crammed} practice reviews`,
  )
}

/** Everything a tab derives from the drafts: status, text and card of each, the review groups, the Today line. */
function draftSignature(ws: ModelWorkspace): string {
  return JSON.stringify({
    all: ws.drafts.all().map((d) => [d.id, d.status, d.front, d.cardId ?? null, d.rejectedAt !== undefined]),
    groups: ws.drafts.groups(),
    summary: ws.drafts.summary(),
  })
}

/**
 * I14 (converged): every acknowledged draft is there; an acknowledged rejection is never undone (the draft is
 * never proposed again); every card an acknowledged acceptance created is kept, and its draft is accepted.
 */
function checkDrafts(w: World, ws: ModelWorkspace, cards: Y.Map<Y.Map<unknown>>): void {
  const o = w.oracle
  for (const id of o.drafts.keys()) check(ws.drafts.get(id) !== undefined, 'I14', () => `draft ${id} lost`)
  for (const id of o.rejected) {
    const d = ws.drafts.get(id)
    check(d?.rejectedAt !== undefined && d.status !== 'proposed', 'I14', () => `rejected draft ${id} came back`)
  }
  for (const [id, made] of o.accepted) {
    check(ws.drafts.get(id)?.status === 'accepted', 'I14', () => `accepted draft ${id} is not accepted`)
    for (const c of made) {
      check(cards.get(c)?.get('draftId') === id, 'I14', () => `card ${c} of draft ${id} lost its provenance`)
    }
  }
}

/** I1, I2 (+ sealed roots hold only sealed objects), I3, I11 (safe ⇒ really stored), I12 (tree of each tab). */
export async function checkContinuous(w: World): Promise<void> {
  const h = history.get(w) ?? { buckets: new Map(), local: new Map() }
  history.set(w, h)
  const reg = await registry(w)
  for (const d of w.destList) {
    const keys = bucketKeys(w, d.prefix)
    // I1: a destination only grows.
    for (const k of h.buckets.get(d.prefix) ?? []) check(keys.has(k), 'I1', () => `${d.name} lost ${k}`)
    h.buckets.set(d.prefix, keys)
    // I2: closure of files on each destination.
    for (const k of keys) {
      const kind = parseKey(k)?.kind
      if (kind === 'seg' || kind === 'ckpt') {
        const refs = reg.refs.get(k)
        check(refs !== undefined, 'I2', () => `${d.name} holds ${k} that no device wrote`)
        for (const ref of refs) {
          check(keys.has(bmanKey(ref)), 'I2', () => `${d.name}: ${k} without its manifest ${ref}`)
          for (const c of reg.chunks.get(bmanKey(ref)) ?? [])
            check(keys.has(c), 'I2', () => `${d.name}: ${k} without chunk ${c}`)
        }
      }
      if (kind === 'bman')
        for (const c of reg.chunks.get(k) ?? []) check(keys.has(c), 'I2', () => `${d.name}: ${k} without chunk ${c}`)
      // Sealed roots never receive plaintext.
      if (d.sealed && (kind === 'seg' || kind === 'ckpt' || kind === 'blob' || kind === 'bman')) {
        const body = w.bucket.read(`${d.prefix}/${k}`) ?? new Uint8Array()
        check(isSealed(body), 'I2', () => `sealed ${d.name} holds plaintext ${k}`)
      }
    }
  }
  for (const dev of w.devices) {
    for (const [i, t] of dev.tabs.entries()) checkTree(t.ws, `${dev.name}/tab${i}`, false)
    // I3: the local log only grows.
    const local = await dev.localKeys()
    for (const k of h.local.get(dev.name) ?? []) check(local.has(k), 'I3', () => `${dev.name} lost local ${k}`)
    h.local.set(dev.name, local)
    // I11 (continuous half): "safe" is never a lie — not while an edit is held in memory.
    const s = await dev.engine.refresh()
    check(!s.safe || dev.unsaved() === 0, 'I11', () => `${dev.name} says safe with unsaved edits`)
    if (s.safe) {
      for (const k of local) {
        const somewhere = [...dev.dests].some((d) => bucketKeys(w, w.dest(d).prefix).has(k))
        check(somewhere, 'I11', () => `${dev.name} says safe but ${k} is on no destination`)
      }
    }
  }
}

/** A signature of everything that can move: remote objects, local objects, unsealed edits. */
export async function snapshotMovement(w: World): Promise<string> {
  const parts: string[] = []
  for (const d of w.destList) parts.push(`${d.prefix}:${w.bucket.keys(`${d.prefix}/`).length}`)
  for (const dev of w.devices) {
    const pending = await dev.base.read(['pending'], (tx) => tx.count('pending'))
    parts.push(`${dev.name}:${(await dev.localKeys()).size}:${pending}`)
  }
  return parts.join('|')
}

function docFrom(updates: Uint8Array[]): Y.Doc {
  const d = new Y.Doc()
  for (const u of updates) Y.applyUpdateV2(d, u)
  return d
}

const noPending = (d: Y.Doc): boolean => d.store.pendingStructs === null && d.store.pendingDs === null

function words(d: Y.Doc, ref: { id: string; field: string }): string[] {
  const t = d.getMap<Y.Text>('texts').get(textKey(ref.id, ref.field as 'body'))
  return t ? t.toString().split(' ') : []
}

/** Is the object stored intact on the destination (opened with this device's key when sealed)? */
async function intactOn(w: World, dev: SimDevice, dest: string, key: Key): Promise<boolean> {
  const d = w.dest(dest)
  const body = w.bucket.read(`${d.prefix}/${key}`)
  if (!body) return false
  if (!d.sealed) return hashMatches(key, body)
  try {
    return hashMatches(key, await createSealer(w.rng).open(dev.keyringFor(dest), key, body))
  } catch (e) {
    if (e instanceof Error && (e.name === 'SealError' || e.name === 'KeyUnavailableError')) return false
    throw e
  }
}

/** After healing: I1–I14. */
export async function checkFinal(w: World): Promise<void> {
  await checkContinuous(w)
  const o = w.oracle
  const tabs = w.devices.flatMap((dev) => dev.tabs)
  const ref = tabs[0]?.doc as Y.Doc
  const refJson = canonicalJson(ref)
  const refSv = Y.encodeStateVector(ref)

  // I4: convergence of every tab of every device.
  for (const dev of w.devices) {
    for (const [i, t] of dev.tabs.entries()) {
      check(canonicalJson(t.doc) === refJson, 'I4', () => `${dev.name}/tab${i} differs from the reference`)
      check(
        Buffer.from(Y.encodeStateVector(t.doc)).equals(Buffer.from(refSv)),
        'I4',
        () => `${dev.name}/tab${i} state vector`,
      )
      check(noPending(t.doc), 'I4', () => `${dev.name}/tab${i} has pending structs`)
    }
  }

  // I5: no acknowledged write lost.
  const courses = ref.getMap<Y.Map<unknown>>('courses')
  for (const [id, title] of o.courses) {
    check(courses.get(id)?.get('title') === title, 'I5', () => `course ${id} (${title}) lost`)
  }
  for (const [tok, where] of o.tokens) {
    if (o.deleted.has(tok)) continue
    check(words(ref, where).includes(tok), 'I5', () => `token ${tok} lost from ${where.id}/${where.field}`)
  }
  const reviewIds = new Set(reviewEvents(ref).map((r) => r.id))
  for (const id of o.reviews.keys()) check(reviewIds.has(id), 'I5', () => `review ${id} lost`)
  const sources = ref.getMap<Y.Map<unknown>>('sources')
  for (const [sid, blob] of o.files) {
    check(sources.get(sid)?.get('blobId') === `cursus-blob:${blob}`, 'I5', () => `source ${sid} lost`)
    for (const dev of w.devices) {
      check((await dev.blobs.get(blob)) !== null, 'I5', () => `${dev.name} cannot open file ${blob}`)
    }
  }

  const sections = ref.getMap<Y.Map<unknown>>('sections')
  for (const id of o.sections.keys()) check(sections.has(id), 'I5', () => `section ${id} lost`)

  // I12: every converged tab derives the same section tree, without writing anything to do so.
  const refTree = treeSignature(tabs[0]?.ws as ModelWorkspace)
  for (const dev of w.devices) {
    for (const [i, t] of dev.tabs.entries()) {
      const sv = Y.encodeStateVector(t.doc)
      checkTree(t.ws, `${dev.name}/tab${i}`, true)
      check(treeSignature(t.ws) === refTree, 'I12', () => `${dev.name}/tab${i} derives another section tree`)
      check(Buffer.from(Y.encodeStateVector(t.doc)).equals(Buffer.from(sv)), 'I12', () => 'reading the tree wrote')
    }
  }

  // I13: sessions and practice.
  checkSessions(w, tabs[0]?.ws as ModelWorkspace)
  const refHistory = JSON.stringify(sessionHistory(tabs[0]?.ws as ModelWorkspace))
  for (const dev of w.devices) {
    for (const [i, t] of dev.tabs.entries()) {
      const sv = Y.encodeStateVector(t.doc)
      checkPractice(t.ws, `${dev.name}/tab${i}`)
      check(JSON.stringify(sessionHistory(t.ws)) === refHistory, 'I13', () => `${dev.name}/tab${i}: another history`)
      check(Buffer.from(Y.encodeStateVector(t.doc)).equals(Buffer.from(sv)), 'I13', () => 'reading sessions wrote')
    }
  }

  // I14: proposed questions.
  checkDrafts(w, tabs[0]?.ws as ModelWorkspace, ref.getMap<Y.Map<unknown>>('cards'))
  const refDrafts = draftSignature(tabs[0]?.ws as ModelWorkspace)
  for (const dev of w.devices) {
    for (const [i, t] of dev.tabs.entries()) {
      const sv = Y.encodeStateVector(t.doc)
      check(draftSignature(t.ws) === refDrafts, 'I14', () => `${dev.name}/tab${i} derives other drafts`)
      check(Buffer.from(Y.encodeStateVector(t.doc)).equals(Buffer.from(sv)), 'I14', () => 'reading drafts wrote')
    }
  }

  // I6: no resurrection.
  for (const tok of o.deleted) {
    const where = o.tokens.get(tok)
    if (where) check(!words(ref, where).includes(tok), 'I6', () => `deleted token ${tok} came back`)
  }
  for (const id of o.voids) {
    const card = o.reviews.get(id) ?? ''
    for (const t of tabs) {
      check(!t.ws.reviews.forCard(card).some((r) => r.id === id), 'I6', () => `voided review ${id} is back`)
    }
  }

  // I7: idempotence — every log object, shuffled and duplicated, gives the same state.
  const reg = await registry(w)
  const updates = [...reg.rows].map(([k, b]) => codec.decode(k, b).update)
  const rng = seededRng(w.params.seed ^ 0x5eed)
  const shuffled = [...updates, ...updates.filter(() => rng.u32() % 3 === 0)]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.u32() % (i + 1)
    const a = shuffled[i] as Uint8Array
    shuffled[i] = shuffled[j] as Uint8Array
    shuffled[j] = a
  }
  const replayed = docFrom(shuffled)
  check(canonicalJson(replayed) === refJson, 'I7', () => 'shuffled replay of all segments differs')
  check(noPending(replayed), 'I7', () => 'shuffled replay left pending structs')

  // I8: relay completeness within each connected group of destinations.
  const used = w.destList.filter((d) => w.devices.some((dev) => dev.dests.has(d.name)))
  const dataOf = (prefix: string) => new Set([...bucketKeys(w, prefix)].filter(isDataKey))
  for (const dev of w.devices) {
    const local = [...(await dev.localKeys())]
    const ds = [...dev.dests]
    for (const d of ds) {
      const remote = dataOf(w.dest(d).prefix)
      for (const k of local) check(remote.has(k), 'I8', () => `${dev.name}: ${k} never reached ${d}`)
      for (const k of remote) check(local.includes(k), 'I8', () => `${dev.name}: ${k} on ${d} never came down`)
    }
  }
  for (const a of used) {
    for (const b of used) {
      const ka = dataOf(a.prefix)
      const kb = dataOf(b.prefix)
      check(ka.size === kb.size && [...ka].every((k) => kb.has(k)), 'I8', () => `${a.name} and ${b.name} differ`)
    }
  }

  // I9: restore from EACH destination alone.
  for (const d of used) {
    const dev = w.devices.find((x) => x.dests.has(d.name)) as SimDevice
    const r = await dev.engine.restoreDrill(d.name)
    check(r.equal, 'I9', () => `restore from ${d.name} alone: ${r.diff.slice(0, 5).join('; ')}`)
  }

  for (const dev of w.devices) {
    // I10: the replayed history equals the captured state.
    const loaded = docFrom((await dev.log.load()).updates)
    for (const [i, t] of dev.tabs.entries()) {
      check(canonicalJson(loaded) === canonicalJson(t.doc), 'I10', () => `${dev.name}/tab${i} ≠ its replayed log`)
    }
    // I11: the status tells the truth.
    const s = await dev.engine.refresh()
    const local = [...(await dev.localKeys())]
    const pending = await dev.base.read(['pending'], (tx) => tx.count('pending'))
    // I5 (local half): after healing, every captured edit was acknowledged by the log.
    check(dev.unsaved() === 0, 'I5', () => `${dev.name}: ${dev.unsaved()} captured edits never saved`)
    let truthSafe = pending === 0 && dev.unsaved() === 0 && dev.dests.size > 0
    for (const k of local) {
      let anywhere = false
      for (const d of dev.dests) if (await intactOn(w, dev, d, k)) anywhere = true
      if (!anywhere) truthSafe = false
    }
    check(s.safe === truthSafe, 'I11', () => `${dev.name}: status safe=${s.safe}, truth=${truthSafe}`)
    for (const ds of s.dests) {
      const present = bucketKeys(w, w.dest(ds.id).prefix)
      const absent = local.filter((k) => !present.has(k)).length
      check(
        ds.unconfirmed === absent,
        'I11',
        () => `${dev.name}/${ds.id}: unconfirmed=${ds.unconfirmed}, absent=${absent}`,
      )
    }
    check(!s.alarm, 'I11', () => `${dev.name}: red banner after healing`)
  }
}
