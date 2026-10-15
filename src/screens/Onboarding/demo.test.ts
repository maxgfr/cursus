import { beforeAll, describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { importDeck } from '../../core/content/deck'
import { photosIn } from '../../core/content/photos'
import type { Clock, LocalStore } from '../../core/contracts/ports'
import type { Id, Review } from '../../core/contracts/workspace'
import { blobStore } from '../../core/log/blobs'
import { refsOf } from '../../core/log/codec'
import { isPhoto } from '../../core/model/photos'
import type { RepoDeps } from '../../core/model/repos'
import { nextPlanned, PlanRepo, sessionHistory } from '../../core/model/sessions'
import { createWorkspace, type ModelWorkspace } from '../../core/model/workspace'
import { virtualClock } from '../../core/ports/clock'
import { seededRng } from '../../core/ports/rng'
import { type CardState, createScheduler, DAY_MS, dayStart, localOffset, studyDay } from '../../core/srs/fsrs'
import { buildQueue } from '../../core/srs/queue'
import { activitySplit } from '../../core/srs/stats'
import { memoryStore } from '../../core/storage/memoryStore'
import { createTranslator, loadCatalog, type Translate } from '../../i18n/index.ts'
import { daysUntil } from '../Today/exam.ts'
import { createDemoCourse, DEMO_EXAM_DAYS } from './demo.ts'

const HOUR = 3_600_000
/** A local noon (the machine's zone): Thursday 2026-10-15. */
const NOON = new Date(2026, 9, 15, 12, 0, 0).getTime()

let t: Translate
beforeAll(async () => {
  await loadCatalog('en')
  t = createTranslator('en')
})

function make(seed: number, now = NOON) {
  const doc = new Y.Doc()
  const clock = virtualClock(now)
  const rng = seededRng(seed, clock)
  const ws = createWorkspace(doc, { rng, clock, deviceId: `dev${seed}` })
  return { doc, clock, rng, ws, store: memoryStore() }
}

/** Today's queue as the Today screen builds it (computeStudy): learning, due reviews, then new cards. */
function today(ws: ModelWorkspace, now: number) {
  const live = new Set(ws.courses.list().map((c) => c.id))
  const cards = ws.cards.list().filter((c) => live.has(c.courseId) && !c.suspended)
  const scheduler = createScheduler({ desiredRetention: ws.prefs.get('desiredRetention') })
  const states = new Map<Id, CardState>()
  for (const c of cards) {
    const events = ws.reviews.forCard(c.id)
    if (events.length > 0) states.set(c.id, scheduler.replay(c.id, events))
  }
  const tz = localOffset(now)
  const queue = buildQueue({
    cards: cards.map((c) => ({ id: c.id })),
    states,
    now,
    tzOffsetMin: tz,
    newPerDay: ws.prefs.get('dailyNewCards'),
  })
  return { queue, states, endOfDay: dayStart(studyDay(now, tz) + 1, tz) }
}

/** The sim's I12 (tree) and I13 (practice never moves the schedule, yet counts in the statistics), on one tab. */
function checkInvariants(ws: ModelWorkspace): void {
  const tree = ws.sections.tree()
  for (const id of tree.ids()) {
    let cur: string | null = id
    for (let steps = 0; cur !== null; steps++) {
      expect(steps).toBeLessThanOrEqual(tree.ids().length)
      const p: string | null = tree.parent(cur)
      if (p !== null) expect(tree.get(p)?.courseId).toBe(tree.get(cur)?.courseId)
      cur = p
    }
  }
  for (const kind of ['sources', 'fiches', 'cards'] as const) {
    for (const e of ws[kind].all()) {
      expect(ws.courses.get(e.courseId)).toBeDefined()
      const s = tree.sectionOf(e)
      if (s !== null) expect(tree.get(s)?.courseId).toBe(e.courseId)
    }
  }
  const log = ws.reviews.yArray.toArray()
  const practice = new Set(log.filter((r) => 'p' in r && r.p === true).map((r) => r.id))
  const without: Review[] = log.filter((r) => !practice.has(r.id))
  const sch = createScheduler()
  for (const card of ws.cards.all()) {
    const mine = ws.reviews.forCard(card.id)
    expect(JSON.stringify(sch.replay(card.id, mine))).toBe(
      JSON.stringify(
        sch.replay(
          card.id,
          without.filter((r) => 'cardId' in r && r.cardId === card.id),
        ),
      ),
    )
  }
  const days = activitySplit(ws.reviews.all(), 0)
  expect(days.reduce((n, d) => n + d.reviews, 0)).toBe(ws.reviews.all().length)
  expect(days.reduce((n, d) => n + d.practice, 0)).toBe(practice.size)
}

/** Everything the doc holds, as plain data. */
function snapshot(doc: Y.Doc): string {
  const out: Record<string, unknown> = {}
  for (const name of [...doc.share.keys()].sort()) {
    const v = doc.share.get(name)
    if (v instanceof Y.Map || v instanceof Y.Array) out[name] = v.toJSON()
  }
  return JSON.stringify(out)
}

function isEmpty(ws: ModelWorkspace, doc: Y.Doc): void {
  for (const repo of [ws.courses, ws.sections, ws.sources, ws.cards, ws.plans]) expect(repo.all()).toEqual([])
  expect(ws.drafts.all()).toEqual([])
  expect(ws.reviews.yArray.length).toBe(0)
  expect(ws.sessions.list()).toEqual([])
  expect(doc.getMap('texts').size).toBe(0)
}

describe('the demo course', () => {
  test('shows every feature: subsets, exam, notes, a deck, photos, cards of every kind, drafts, history, a plan', async () => {
    const { ws, store, clock } = make(1)
    const courseId = await createDemoCourse({ ws, store, clock }, t, 'en')

    const course = ws.courses.get(courseId)
    expect(course?.title).toBe('Demo: Cell biology')
    expect(course?.language).toBe('en')
    expect(daysUntil(course?.examDate, NOON)).toBe(DEMO_EXAM_DAYS)

    // Two subsets, each with two levels.
    const tree = ws.sections.tree()
    const top = tree.children(courseId, null)
    expect(top.map((s) => s.name)).toEqual(['Membranes', 'Organelles'])
    expect(top.flatMap((s) => tree.children(courseId, s.id)).map((s) => s.name)).toEqual([
      'Structure',
      'Transport',
      'Mitochondria',
    ])
    // Cards at the root, in every subset and below.
    const at = (sectionId: Id | null) => ws.cards.list({ courseId }).filter((c) => tree.sectionOf(c) === sectionId)
    expect(at(null).length).toBe(2)
    for (const s of tree.ids()) expect(at(s).length).toBeGreaterThan(0)

    // Two notes in Markdown, the first with headings, a list, a table and maths inline and displayed.
    const sources = ws.sources.list({ courseId })
    const notes = sources.filter((s) => s.kind === 'note' && s.support === undefined)
    expect(notes.length).toBe(2)
    const body = ws.text({ id: notes.find((n) => tree.sectionOf(n) === null)?.id ?? '', field: 'body' }).toString()
    expect(body).toMatch(/^# /)
    expect(body).toMatch(/\n## /)
    expect(body).toMatch(/\n- /)
    expect(body).toMatch(/\n\| --- \|/)
    expect(body).toMatch(/\$\$\\frac/)
    expect(body).toMatch(/[^$]\$r\$/)

    // A slide deck: its file and picture stored before the source named them, read back slide by slide.
    const deck = sources.find((s) => s.support === 'deck')
    expect(deck?.kind).toBe('note')
    expect(deck?.blobIds?.length).toBe(2)
    const file = await blobStore(store).get(deck?.blobId ?? '')
    expect(file?.type).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    const read = await importDeck(new Uint8Array(await (file ?? new Blob()).arrayBuffer()))
    expect(read.units.map((u) => u.kind)).toEqual(['slide', 'slide', 'slide', 'slide'])
    expect(read.units.every((u) => (u.notes ?? '') !== '')).toBe(true)
    expect(read.units[1]?.images.length).toBe(1)
    expect(read.units[2]?.text).toContain('| --- |')

    // Two photos with captions: one attached to the first note, one on a card's front.
    const photos = sources.filter(isPhoto)
    expect(photos.length).toBe(2)
    expect(photos.every((p) => (p.caption ?? '') !== '' && p.width !== undefined)).toBe(true)
    const attached = photos.find((p) => p.attachedTo !== undefined)
    expect(attached?.attachedTo).toBe(notes.find((n) => tree.sectionOf(n) === null)?.id)
    const fronts = ws.cards
      .list({ courseId })
      .map((c) => ({ c, front: ws.text({ id: c.id, field: 'front' }).toString() }))
    const illustrated = fronts.filter(({ front }) => photosIn(front).length > 0)
    expect(illustrated.length).toBe(1)
    expect(photosIn(illustrated[0]?.front ?? '')[0]?.blobId).toBe(photos.find((p) => !p.attachedTo)?.blobId ?? '')

    // Every file the doc names is on this device.
    const refs = refsOf(Y.encodeStateAsUpdateV2(ws.doc))
    expect(refs.length).toBe(4)
    for (const ref of refs) expect(await blobStore(store).manifest(ref)).not.toBeNull()

    // Cards of every kind: basic, cloze, maths, citing a slide, accepted from a proposed question.
    const cards = ws.cards.list({ courseId })
    expect(cards.length).toBe(16)
    expect(cards.some((c) => c.kind === 'cloze')).toBe(true)
    expect(cards.filter((c) => c.sourceId === deck?.id && c.unit !== undefined).length).toBeGreaterThanOrEqual(4)
    expect(fronts.filter(({ c }) => ws.text({ id: c.id, field: 'back' }).toString().includes('$')).length).toBe(4)
    const fromDrafts = cards.filter((c) => c.draftId !== undefined)
    expect(fromDrafts.map((c) => ws.drafts.get(c.draftId ?? '')?.type).sort()).toEqual(['explain', 'qa'])

    // Questions proposed on the slides, grouped by slide; one rejected for good.
    expect(ws.drafts.summary().total).toBe(5)
    expect(ws.drafts.groups()[0]?.units.map((u) => [u.unit, u.unitKind, u.drafts.length])).toEqual([
      [2, 'slide', 1],
      [3, 'slide', 2],
      [4, 'slide', 2],
    ])
    expect(new Set(ws.drafts.list({ status: 'proposed' }).map((d) => d.type))).toEqual(
      new Set(['qa', 'cloze', 'explain']),
    )
    expect(ws.drafts.list({ status: 'rejected' }).length).toBe(1)
    expect(ws.drafts.list({ status: 'accepted' }).length).toBe(2)

    // Two weeks of reviews; a counted session and a cramming one, each with a missed card; a weekly plan.
    const all = ws.reviews.all()
    expect(Math.min(...all.map((r) => r.at))).toBeGreaterThanOrEqual(NOON - 15 * DAY_MS)
    expect(Math.max(...all.map((r) => r.at))).toBeLessThan(NOON)
    expect(new Set(all.map((r) => studyDay(r.at, localOffset(r.at)))).size).toBeGreaterThanOrEqual(8)
    const history = sessionHistory(ws)
    expect(history.map((h) => [h.session.practice, h.failed.length > 0, h.session.endedAt !== undefined])).toEqual([
      [false, true, true],
      [true, true, true],
    ])
    expect(ws.reviews.forSession(history[1]?.session.id ?? '').every((r) => r.p === true)).toBe(true)
    expect(ws.reviews.forSession(history[0]?.session.id ?? '').some((r) => r.p === true)).toBe(false)
    const next = nextPlanned(ws.plans.list(), NOON)
    expect(next?.plan.courseId).toBe(courseId)
    expect((next?.at ?? Number.POSITIVE_INFINITY) - NOON).toBeLessThan(7 * DAY_MS)

    checkInvariants(ws)
  })

  // Card ids seed FSRS's fuzz; a study day starts at 04:00.
  for (const [seed, hour] of [
    [2, 0.5],
    [3, 3.9],
    [4, 4.1],
    [5, 9],
    [6, 18],
    [7, 23.9],
  ] as const) {
    test(`exactly three cards are due today, the new one illustrated (seed ${seed}, ${hour} h)`, async () => {
      const now = new Date(2026, 9, 15).getTime() + hour * HOUR
      const { ws, store, clock } = make(seed, now)
      await createDemoCourse({ ws, store, clock }, t)
      const { queue, states, endOfDay } = today(ws, now)
      expect([seed, queue.map((q) => q.kind).sort()]).toEqual([seed, ['learning', 'new', 'review']])
      // Every other card comes back after today, with a margin: nothing becomes due while the student looks.
      const queued = new Set(queue.map((q) => q.cardId))
      for (const [id, s] of states) {
        if (queued.has(id)) expect(s.due).toBeLessThan(now - HOUR)
        else expect(s.due).toBeGreaterThan(Math.max(endOfDay, now + DAY_MS))
      }
      // The new card is the illustrated one.
      const fresh = queue.find((q) => q.kind === 'new')?.cardId ?? ''
      expect(photosIn(ws.text({ id: fresh, field: 'front' }).toString()).length).toBe(1)
    })
  }

  test('the same clock and seed make the same course, byte for byte; asking twice makes a second course', async () => {
    const a = make(9)
    const b = make(9)
    await createDemoCourse(a, t, 'en')
    await createDemoCourse(b, t, 'en')
    expect(snapshot(b.doc)).toBe(snapshot(a.doc))

    const first = a.ws.courses.list()[0]?.id ?? ''
    const second = await createDemoCourse(a, t, 'en')
    expect(second).not.toBe(first)
    expect(a.ws.courses.list().length).toBe(2)
    expect(a.ws.cards.list({ courseId: second }).length).toBe(a.ws.cards.list({ courseId: first }).length)
    expect(a.ws.sections.tree().children(second, null).length).toBe(2)
    expect(a.ws.drafts.summary().total).toBe(10)
    checkInvariants(a.ws)
  })

  test('never touches the student’s own courses, and can be trashed and restored like any course', async () => {
    const { ws, store, clock, doc } = make(10)
    const mine = ws.courses.create({ title: 'Contract law' })
    const card = ws.cards.create({ courseId: mine, kind: 'basic' })
    ws.text({ id: card, field: 'front' }).insert(0, 'Offer?')
    ws.reviews.record({ cardId: card, rating: 3, at: NOON - DAY_MS, ms: 5000 })
    const before = {
      course: ws.courses.get(mine),
      card: ws.cards.get(card),
      text: ws.text({ id: card, field: 'front' }).toString(),
      reviews: ws.reviews.forCard(card),
    }

    const demo = await createDemoCourse({ ws, store, clock }, t)
    expect({
      course: ws.courses.get(mine),
      card: ws.cards.get(card),
      text: ws.text({ id: card, field: 'front' }).toString(),
      reviews: ws.reviews.forCard(card),
    }).toEqual(before)
    expect(doc.getMap('prefs').size).toBe(0)

    ws.courses.trash(demo)
    expect(ws.courses.list().map((c) => c.id)).toEqual([mine])
    expect(ws.drafts.summary().total).toBe(0)
    // Only the student's own card, learning since yesterday, is left today.
    expect(today(ws, NOON).queue.map((q) => q.cardId)).toEqual([card])
    ws.courses.restore(demo)
    expect(ws.drafts.summary().total).toBe(5)
    expect(today(ws, NOON).queue.length).toBe(3 + 1)
  })

  test('all or nothing: a failure while writing leaves nothing in the library', async () => {
    const { ws, store, clock, doc, rng } = make(11)
    class FailingPlans extends PlanRepo {
      override create(): Id {
        throw new Error('disk full')
      }
    }
    const deps: RepoDeps = { doc, rng, clock }
    const broken: ModelWorkspace = { ...ws, plans: new FailingPlans(deps) }
    await expect(createDemoCourse({ ws: broken, store, clock }, t)).rejects.toThrow('disk full')
    isEmpty(ws, doc)
  })

  test('all or nothing: files that cannot be stored stop it before any write', async () => {
    const { ws, clock, doc } = make(12)
    const store: LocalStore = { ...memoryStore(), commit: () => Promise.reject(new Error('quota exceeded')) }
    await expect(createDemoCourse({ ws, store, clock }, t)).rejects.toThrow('quota exceeded')
    isEmpty(ws, doc)
  })

  test('is written in the student’s language', async () => {
    for (const locale of ['de', 'fr'] as const) {
      await loadCatalog(locale)
      const { ws, store } = make(13)
      const clock: Clock = { now: () => NOON }
      const id = await createDemoCourse({ ws, store, clock }, createTranslator(locale), locale)
      expect(ws.courses.get(id)?.title).toBe(locale === 'de' ? 'Demo: Zellbiologie' : 'Démo : biologie cellulaire')
      expect(ws.courses.get(id)?.language).toBe(locale)
    }
  })
})
