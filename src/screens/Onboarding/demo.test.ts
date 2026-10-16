import { beforeAll, describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { importDeck } from '../../core/content/deck'
import type { PdfJsLoader } from '../../core/content/pdf'
import { photosIn } from '../../core/content/photos'
import type { Clock, LocalStore } from '../../core/contracts/ports'
import type { Id, Review, Weekday } from '../../core/contracts/workspace'
import { blobRef, blobStore } from '../../core/log/blobs'
import { refsOf } from '../../core/log/codec'
import { clozeIndexes } from '../../core/model/cloze'
import { isPhoto } from '../../core/model/photos'
import type { RepoDeps } from '../../core/model/repos'
import { schedulerOf } from '../../core/model/reviewSettings'
import { nextPlanned, PlanRepo, sessionHistory } from '../../core/model/sessions'
import { createWorkspace, type ModelWorkspace } from '../../core/model/workspace'
import { virtualClock } from '../../core/ports/clock'
import { seededRng } from '../../core/ports/rng'
import { type CardState, createScheduler, DAY_MS, dayStart, localOffset, studyDay } from '../../core/srs/fsrs'
import { buildQueue } from '../../core/srs/queue'
import { activitySplit } from '../../core/srs/stats'
import { memoryStore } from '../../core/storage/memoryStore'
import { type BaseLocale, type Catalog, createTranslator, loadCatalog, type Translate } from '../../i18n/index.ts'
import { daysUntil } from '../Today/exam.ts'
import { createDemoCourse, DEMO_EXAM_DAYS, DEMO_MIDTERM_DAYS, demoTranslator } from './demo.ts'

const HOUR = 3_600_000
/** A local noon (the machine's zone): Thursday 2026-10-15. */
const NOON = new Date(2026, 9, 15, 12, 0, 0).getTime()

/** pdf.js's Node build, its worker run in-process: the demo's PDFs read as the app reads them. */
const pdfjs: PdfJsLoader = async () => {
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  mod.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  return mod
}

let t: Translate
const catalogs = {} as Record<BaseLocale, Catalog>
beforeAll(async () => {
  for (const locale of ['en', 'de', 'fr'] as const) catalogs[locale] = await loadCatalog(locale)
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
  const scheduler = schedulerOf(ws)
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
  for (const repo of [ws.courses, ws.sections, ws.sources, ws.fiches, ws.cards, ws.plans])
    expect(repo.all()).toEqual([])
  expect(ws.drafts.all()).toEqual([])
  expect(ws.reviews.yArray.length).toBe(0)
  expect(ws.sessions.list()).toEqual([])
  expect(doc.getMap('texts').size).toBe(0)
}

/** The bytes of a stored file. */
async function fileOf(store: LocalStore, blobId: string | undefined): Promise<{ type: string; bytes: Uint8Array }> {
  const file = await blobStore(store).get(blobId ?? '')
  if (file === null) throw new Error(`file ${blobId} is not stored`)
  return { type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }
}

/** ISO weekday (1 = Monday) of an instant, in local time. */
const ISO_WEEKDAY: readonly Weekday[] = [7, 1, 2, 3, 4, 5, 6]
const isoWeekday = (at: number): Weekday => ISO_WEEKDAY[new Date(at).getDay()] ?? 1

/**
 * The shape of a Markdown text, its words aside: the kind of each line (heading level, list, table, code fence,
 * displayed maths, quote), then how many inline formulas, bold and italic runs, code spans, struck runs, links,
 * photos and blanks (with hints) it holds.
 */
function markdownShape(text: string): string {
  const kinds = text.split('\n').map((line) => {
    const heading = /^(#{1,6}) /.exec(line)
    if (heading) return `h${heading[1]?.length}`
    if (line.startsWith('```')) return 'fence'
    if (line.startsWith('$$')) return 'math'
    if (line.startsWith('|')) return 'table'
    if (line.startsWith('- ')) return 'ul'
    if (/^\d+\. /.test(line)) return 'ol'
    if (line.startsWith('> ')) return 'quote'
    return line.trim() === '' ? '' : 'p'
  })
  const count = (re: RegExp) => (text.match(re) ?? []).length
  return JSON.stringify({
    lines: kinds,
    math: count(/\$/g),
    bold: count(/\*\*/g),
    italic: count(/(^|[^*])\*[^*\s][^*\n]*\*(?!\*)/g),
    code: count(/`/g),
    struck: count(/~~/g),
    links: count(/\]\(https:/g),
    photos: photosIn(text).length,
    blanks: clozeIndexes(text),
    hints: count(/\{\{c\d+::[^:}]+::[^}]+\}\}/g),
  })
}

/** Every text of the course a student reads, with where it is (entity id and field). */
function textsOf(ws: ModelWorkspace, courseId: Id): Map<string, string> {
  const out = new Map<string, string>()
  const put = (key: string, value: string | undefined) => {
    if (value !== undefined && value.trim() !== '') out.set(key, value)
  }
  put(`${courseId}.title`, ws.courses.get(courseId)?.title)
  for (const s of ws.sections.all()) put(`${s.id}.name`, s.name)
  for (const s of ws.sources.list({ courseId })) {
    put(`${s.id}.title`, s.title)
    put(`${s.id}.caption`, s.caption)
    put(`${s.id}.body`, ws.text({ id: s.id, field: 'body' }).toString())
  }
  for (const f of ws.fiches.list({ courseId })) {
    put(`${f.id}.title`, f.title)
    put(`${f.id}.body`, ws.text({ id: f.id, field: 'body' }).toString())
  }
  for (const c of ws.cards.list({ courseId })) {
    put(`${c.id}.front`, ws.text({ id: c.id, field: 'front' }).toString())
    put(`${c.id}.back`, ws.text({ id: c.id, field: 'back' }).toString())
  }
  for (const d of ws.drafts.all()) {
    put(`${d.id}.front`, d.front)
    put(`${d.id}.back`, d.back)
    put(`${d.id}.quote`, d.quote)
  }
  for (const p of ws.plans.list()) put(`${p.id}.name`, p.name)
  return out
}

/** The course with its words replaced by their shape: the same in every language. */
function structureOf(ws: ModelWorkspace, courseId: Id): unknown {
  const tree = ws.sections.tree()
  const texts = textsOf(ws, courseId)
  const shaped = Object.fromEntries([...texts].map(([k, v]) => [k, markdownShape(v)]))
  return {
    shaped,
    sections: ws.sections.all().map((s) => [s.id, s.parentId, s.examDate, s.deletedAt !== undefined]),
    sources: ws.sources
      .list({ courseId })
      .map((s) => [s.id, tree.sectionOf(s), s.kind, s.support, s.attachedTo, s.blobIds?.length, s.width]),
    fiches: ws.fiches.list({ courseId }).map((f) => [f.id, tree.sectionOf(f), f.sourceIds]),
    cards: ws.cards.list({ courseId }).map((c) => [c.id, tree.sectionOf(c), c.kind, c.origin, c.sourceId, c.unit]),
    drafts: ws.drafts.all().map((d) => [d.id, d.status, d.sourceId, d.unit, d.unitKind, d.unitLabel, d.kind, d.type]),
    plans: ws.plans.list().map((p) => [p.id, p.sectionId, p.kind, p.limit, p.weekdays, p.time, p.practice]),
    sessions: ws.sessions.list(),
    reviews: ws.reviews.all().map((r) => [r.cardId, r.rating, r.at, r.p, r.sid]),
  }
}

describe('the demo course', () => {
  test('shows every feature: subsets, exams, notes, files, photos, study sheets, cards, sessions, plans', async () => {
    const { ws, store, clock } = make(1)
    const courseId = await createDemoCourse({ ws, store, clock }, t, 'en')

    const course = ws.courses.get(courseId)
    expect(course?.title).toBe('Demo: Cell biology')
    expect(course?.language).toBe('en')
    expect(daysUntil(course?.examDate, NOON)).toBe(DEMO_EXAM_DAYS)

    // Two subsets, each with two levels; the first has its own midterm, before the exam; an empty one is in the trash.
    const tree = ws.sections.tree()
    const top = tree.children(courseId, null)
    expect(top.map((s) => s.name)).toEqual(['Membranes', 'Organelles'])
    expect(top.map((s) => daysUntil(s.examDate, NOON))).toEqual([DEMO_MIDTERM_DAYS, null])
    expect(DEMO_MIDTERM_DAYS).toBeLessThan(DEMO_EXAM_DAYS)
    expect(top.flatMap((s) => tree.children(courseId, s.id)).map((s) => s.name)).toEqual([
      'Structure',
      'Transport',
      'Mitochondria',
    ])
    const id = (name: string) => ws.sections.all().find((s) => s.name === name)?.id ?? ''
    const trashed = tree.children(courseId, null, { trashed: true }).filter((s) => s.deletedAt !== undefined)
    expect(trashed.map((s) => s.name)).toEqual(['Last year’s notes'])
    const live = tree.ids().filter((s) => !tree.hidden(s))
    expect(live.length).toBe(5)

    // Cards and sources at the root, in every live subset and below; nothing in the trashed one.
    const sources = ws.sources.list({ courseId })
    const at = (sectionId: Id | null) => ws.cards.list({ courseId }).filter((c) => tree.sectionOf(c) === sectionId)
    expect(at(null).length).toBe(2)
    for (const s of live) {
      expect(at(s).length).toBeGreaterThan(0)
      expect(sources.filter((x) => tree.sectionOf(x) === s).length).toBeGreaterThan(0)
    }
    for (const s of trashed) expect(ws.sources.all().filter((x) => x.sectionId === s.id)).toEqual([])

    // Three notes in Markdown: the first with headings at three levels, lists, a table, maths inline and displayed,
    // a code block and code inline, italics, a link and struck text; a pasted one, as pasting a text makes.
    const notes = sources
      .filter((s) => s.kind === 'note' && s.support === undefined)
      .sort((a, b) => a.createdAt - b.createdAt || (a.title < b.title ? -1 : 1))
    expect(notes.map((n) => [n.title, tree.sectionOf(n)])).toEqual([
      ['Cell biology: the essentials', null],
      ['How mitochondria make ATP', id('Mitochondria')],
      [t('course.pastedNote'), id('Membranes')],
    ])
    // A note is never named as its section: « From … » on a card and a sheet's citations name the note.
    for (const n of notes) expect(tree.get(tree.sectionOf(n) ?? '')?.name).not.toBe(n.title)
    const body = ws.text({ id: notes[0]?.id ?? '', field: 'body' }).toString()
    expect(body).toMatch(/^# /)
    expect(body).toMatch(/\n## /)
    expect(body).toMatch(/\n### /)
    expect(body).toMatch(/\n- /)
    expect(body).toMatch(/\n\| --- \|/)
    expect(body).toMatch(/\$\$\\frac/)
    expect(body).toMatch(/[^$]\$r\$/)
    expect(body).toMatch(/\n```python\n(.+\n)+```\n/)
    expect(body).toMatch(/[^`]`r`[^`]/)
    expect(body).toMatch(/ \*[a-z][^*]+\* /)
    expect(body).toMatch(/\[Wikipedia\]\(https:\/\/en\.wikipedia\.org\/[^)]+\)/)
    expect(body).toMatch(/~~[^~]+~~/)
    expect(ws.text({ id: notes[1]?.id ?? '', field: 'body' }).toString()).toMatch(/\n1\. [\s\S]*\n> /)
    expect(ws.text({ id: notes[2]?.id ?? '', field: 'body' }).toString()).not.toMatch(/[#*|`$]/)

    // A slide deck: its file and picture stored before the source named them, read back slide by slide.
    const deck = sources.find((s) => s.support === 'deck')
    expect(deck?.kind).toBe('note')
    expect(deck?.blobIds?.length).toBe(2)
    const deckFile = await fileOf(store, deck?.blobId)
    expect(deckFile.type).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    const read = await importDeck(deckFile.bytes)
    expect(read.units.map((u) => u.kind)).toEqual(['slide', 'slide', 'slide', 'slide'])
    expect(read.units.every((u) => (u.notes ?? '') !== '')).toBe(true)
    expect(read.units[1]?.images.length).toBe(1)
    expect(read.units[2]?.text).toContain('| --- |')

    // A Word handout in Transport, read section by section (an introduction, three headings, one below another).
    const doc = sources.find((s) => s.support === 'document' && s.kind === 'note')
    expect(doc?.title).toBe('Lab 2: red blood cells in three solutions')
    expect(tree.sectionOf(doc ?? { courseId })).toBe(id('Transport'))
    const docFile = await fileOf(store, doc?.blobId)
    expect(docFile.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const handout = await importDeck(docFile.bytes)
    expect(handout.units.map((u) => [u.kind, u.label, u.title])).toEqual([
      ['section', '0', 'Lab 2: red blood cells in three solutions'],
      ['section', '1', 'Aim'],
      ['section', '2', 'Method'],
      ['section', '2.1', 'Safety'],
      ['section', '3', 'Expected results'],
    ])
    expect(handout.units[2]?.text).toMatch(/^- .+\n- .+\n- /)
    expect(handout.units[4]?.text).toContain('| --- |')

    // A past paper in Structure, read page by page, and a syllabus kept as a plain PDF, to read in the app on demand.
    const paper = sources.find((s) => s.kind === 'pdf' && s.support === 'document')
    expect(tree.sectionOf(paper ?? { courseId })).toBe(id('Structure'))
    expect(paper?.blobIds).toEqual([blobRef(paper?.blobId ?? '')])
    const paperFile = await fileOf(store, paper?.blobId)
    expect(paperFile.type).toBe('application/pdf')
    const pages = await importDeck(paperFile.bytes, { pdfjs })
    expect([pages.kind, pages.format, pages.title]).toEqual(['document', 'pdf', 'Midterm 2025: membranes (past paper)'])
    expect(pages.units.map((u) => u.kind)).toEqual(['page', 'page'])
    expect(pages.units[0]?.text).toContain('Draw a phospholipid bilayer.')
    expect(pages.units[1]?.text).toContain('Water flows in by osmosis')
    // O₂, CO₂ and Na⁺ as the rest of the course writes them: drawn smaller and lowered, read back as such.
    expect(pages.units[0]?.text).toContain('Why do O₂ and CO₂ cross the membrane while Na⁺ does not?')
    expect(pages.units.map((u) => u.text).join('\n')).not.toMatch(/\bC?O2\b|Na\+/)
    const syllabus = sources.find((s) => s.kind === 'pdf' && s.support === undefined)
    expect([syllabus?.title, tree.sectionOf(syllabus ?? { courseId })]).toEqual(['Syllabus', null])
    const syllabusFile = await fileOf(store, syllabus?.blobId)
    expect(syllabusFile.type).toBe('application/pdf')
    // Read in the app, each line of the syllabus keeps its own line.
    expect((await importDeck(syllabusFile.bytes, { pdfjs })).units[0]?.text).toContain(
      'Lecture 1: cells and their parts\nLecture 2: organelles\nLecture 3: membranes and transport\n',
    )

    // Two photos with captions: one attached to the first note, one on a card's front with notes of its own.
    const photos = sources.filter(isPhoto)
    expect(photos.length).toBe(2)
    expect(photos.every((p) => (p.caption ?? '') !== '' && p.width !== undefined)).toBe(true)
    const attached = photos.find((p) => p.attachedTo !== undefined)
    expect(attached?.attachedTo).toBe(notes[0]?.id)
    const sketch = photos.find((p) => p.attachedTo === undefined)
    expect(ws.text({ id: sketch?.id ?? '', field: 'body' }).toString()).toContain('cristae')
    const fronts = ws.cards
      .list({ courseId })
      .map((c) => ({ c, front: ws.text({ id: c.id, field: 'front' }).toString() }))
    const illustrated = fronts.filter(({ front }) => photosIn(front).length > 0)
    expect(illustrated.length).toBe(1)
    expect(photosIn(illustrated[0]?.front ?? '')[0]?.blobId).toBe(sketch?.blobId ?? '')

    // Every file the doc names is on this device (deck and its picture, handout, past paper, photos).
    const refs = refsOf(Y.encodeStateAsUpdateV2(ws.doc))
    expect(refs.length).toBe(6)
    for (const ref of refs) expect(await blobStore(store).manifest(ref)).not.toBeNull()

    // Study sheets in two subsets, as « Understand » saves them: a summary, a heading per point, its source cited.
    const fiches = [...ws.fiches.list({ courseId })].sort((a, b) => (a.title < b.title ? -1 : 1))
    expect(fiches.map((f) => [f.title, tree.sectionOf(f)])).toEqual([
      ['Cellular respiration', id('Mitochondria')],
      ['Membrane transport at a glance', id('Membranes')],
    ])
    for (const f of fiches) {
      const sheet = ws.text({ id: f.id, field: 'body' }).toString()
      expect(sheet).toMatch(/^[^#\n][^\n]+\n\n## /)
      const cited = [...sheet.matchAll(/^\*(.+)\*$/gm)].map((m) => m[1])
      expect(cited.length).toBe(3)
      const titles = (f.sourceIds ?? []).map((s) => ws.sources.get(s)?.title)
      expect(new Set(cited)).toEqual(new Set(titles))
    }

    // Cards of every kind: basic, cloze (one with a hint), maths, a table, citing a slide, two written by AI.
    const cards = ws.cards.list({ courseId })
    expect(cards.length).toBe(16)
    const clozes = fronts.filter(({ c }) => c.kind === 'cloze')
    expect(clozes.length).toBe(4)
    expect(clozes.every(({ front }) => clozeIndexes(front).length === 2)).toBe(true)
    expect(clozes.filter(({ front }) => /\{\{c1::[^:}]+::[^}]+\}\}/.test(front)).length).toBe(1)
    const backs = cards.map((c) => ws.text({ id: c.id, field: 'back' }).toString())
    expect(backs.filter((b) => b.includes('$')).length).toBe(4)
    expect(backs.filter((b) => b.includes('\n| --- | --- |\n')).length).toBe(1)
    expect(cards.filter((c) => c.sourceId === deck?.id && c.unit !== undefined).length).toBeGreaterThanOrEqual(4)
    // Written by AI from the slides and kept: ordinary cards citing their slide, from no suggestion.
    const byAi = cards.filter((c) => c.origin === 'ai').sort((a, b) => (a.unit ?? 0) - (b.unit ?? 0))
    expect(byAi.map((c) => [c.sourceId, c.unit, c.draftId])).toEqual([
      [deck?.id, 2, undefined],
      [deck?.id, 4, undefined],
    ])

    // Nothing waits in « Suggested cards », not even a rejected one: suggestions are made only when asked for.
    expect(ws.drafts.all()).toEqual([])
    expect(ws.drafts.summary().total).toBe(0)

    // Two weeks of reviews: a counted session started from the weekly plan, a cramming one, and the relaunch of the
    // card it missed; two plans, one a practice of the midterm's subset.
    const all = ws.reviews.all()
    expect(Math.min(...all.map((r) => r.at))).toBeGreaterThanOrEqual(NOON - 15 * DAY_MS)
    expect(Math.max(...all.map((r) => r.at))).toBeLessThan(NOON)
    expect(new Set(all.map((r) => studyDay(r.at, localOffset(r.at)))).size).toBeGreaterThanOrEqual(8)
    const history = sessionHistory(ws)
    expect(
      history.map((h) => [h.session.kind, h.session.practice, h.failed.length, h.session.endedAt !== undefined]),
    ).toEqual([
      ['due', false, 1, true],
      ['failed', true, 0, true],
      ['all', true, 1, true],
    ])
    const [countedS, relaunch, cram] = history
    expect(relaunch?.session.cardIds).toEqual(cram?.failed)
    expect(relaunch?.session.scope).toEqual(cram?.session.scope)
    expect(relaunch?.reviews).toBe(1)
    for (const h of [relaunch, cram]) expect(ws.reviews.forSession(h?.session.id ?? '').every((r) => r.p)).toBe(true)
    expect(ws.reviews.forSession(countedS?.session.id ?? '').some((r) => r.p === true)).toBe(false)
    const plans = ws.plans.list()
    const weekly = plans.find((p) => p.id === countedS?.session.planId)
    expect(weekly?.name).toBe('Weekly review')
    expect(weekly?.weekdays).toContain(isoWeekday(countedS?.session.startedAt ?? 0))
    // Each past session took place when it says: the counted one at the plan's time, lasting a minute a card; the
    // cramming in the evening; each holds its reviews.
    const hhmm = (at: number | undefined) => {
      const d = new Date(at ?? 0)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    expect(hhmm(countedS?.session.startedAt)).toBe(weekly?.time ?? '')
    expect(hhmm(cram?.session.startedAt)).toBe('20:30')
    for (const h of [countedS, relaunch, cram]) {
      const { startedAt = 0, endedAt = 0, id: sid = '' } = h?.session ?? {}
      const held = ws.reviews.forSession(sid)
      expect(endedAt - startedAt).toBe((held.length + 1) * 60_000)
      for (const r of held) expect(r.at > startedAt && r.at < endedAt).toBe(true)
    }
    expect(weekly?.weekdays).not.toContain(isoWeekday(NOON))
    const midterm = plans.find((p) => p.id !== weekly?.id)
    expect([midterm?.name, midterm?.sectionId, midterm?.kind, midterm?.limit, midterm?.practice]).toEqual([
      'Before the midterm',
      id('Membranes'),
      'ahead',
      20,
      true,
    ])
    const next = nextPlanned(plans, NOON)
    expect(next?.plan.id).toBe(weekly?.id)
    expect((next?.at ?? Number.POSITIVE_INFINITY) - NOON).toBeLessThan(2 * DAY_MS)

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
    expect(a.ws.sources.list({ courseId: second }).length).toBe(a.ws.sources.list({ courseId: first }).length)
    expect(a.ws.fiches.list({ courseId: second }).length).toBe(2)
    expect(a.ws.sections.tree().children(second, null).length).toBe(2)
    expect(a.ws.drafts.all()).toEqual([])
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
    expect(ws.drafts.all()).toEqual([])
    // Only the student's own card, learning since yesterday, is left today.
    expect(today(ws, NOON).queue.map((q) => q.cardId)).toEqual([card])
    ws.courses.restore(demo)
    expect(ws.drafts.all()).toEqual([])
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
      const { ws, store } = make(13)
      const clock: Clock = { now: () => NOON }
      const id = await createDemoCourse({ ws, store, clock }, await demoTranslator(locale), locale)
      // French sets a no-break space before its colon: the title never breaks there.
      expect(ws.courses.get(id)?.title).toBe(locale === 'de' ? 'Demo: Zellbiologie' : 'Démo\u00a0: biologie cellulaire')
      expect(ws.courses.get(id)?.language).toBe(locale)
    }
  })

  test('every language makes the same course, word for word translated: same structure, nothing left in English', async () => {
    const made = new Map<BaseLocale, { ws: ModelWorkspace; store: LocalStore; courseId: Id }>()
    for (const locale of ['en', 'de', 'fr'] as const) {
      const { ws, store, clock } = make(14)
      made.set(locale, { ws, store, courseId: await createDemoCourse({ ws, store, clock }, createTranslator(locale)) })
    }
    const en = made.get('en')
    if (en === undefined) throw new Error('no English course')
    const enTexts = textsOf(en.ws, en.courseId)
    // Words that are the same in both languages.
    const same: Readonly<Record<'de' | 'fr', readonly string[]>> = {
      de: ['Transport'],
      fr: ['Membranes', 'Structure', 'Transport'],
    }
    for (const locale of ['de', 'fr'] as const) {
      const other = made.get(locale)
      if (other === undefined) throw new Error(`no ${locale} course`)
      // The same entities, at the same places, with Markdown of the same shape (lists, tables, maths, code, blanks).
      expect(structureOf(other.ws, other.courseId)).toEqual(structureOf(en.ws, en.courseId))
      // Every text translated: none equal to the English one, none a catalog key or a placeholder left unfilled.
      const texts = textsOf(other.ws, other.courseId)
      expect([...texts.keys()]).toEqual([...enTexts.keys()])
      const untranslated = [...texts].filter(([k, v]) => v === enTexts.get(k) && !same[locale].includes(v))
      expect([locale, untranslated]).toEqual([locale, []])
      for (const v of texts.values()) {
        expect(v).not.toMatch(/^(common|today|course|review|ai|settings|sync|anki|errors|photos|chat)\.\w+$/)
        expect(v).not.toMatch(/\{(deck|lab|note|source|count)\}/)
      }
    }
    // The files are written in each language too: the handout's sections and the past paper's pages.
    const firstPage = new Map<BaseLocale, string>()
    for (const [locale, { ws, store, courseId }] of made) {
      const tr = createTranslator(locale)
      const sources = ws.sources.list({ courseId })
      const doc = sources.find((s) => s.support === 'document' && s.kind === 'note')
      const handout = await importDeck((await fileOf(store, doc?.blobId)).bytes)
      // The reader gives titles back with single spaces (a French no-break space before « : » too).
      expect(handout.units.map((u) => u.title)).toEqual(
        [
          tr('today.demoDocTitle'),
          tr('today.demoDocAimTitle'),
          tr('today.demoDocMethodTitle'),
          tr('today.demoDocSafetyTitle'),
          tr('today.demoDocResultsTitle'),
        ].map((title) => title.replace(/\s+/g, ' ')),
      )
      const paper = sources.find((s) => s.kind === 'pdf' && s.support === 'document')
      const pages = await importDeck((await fileOf(store, paper?.blobId)).bytes, { pdfjs })
      expect(pages.title).toBe(paper?.title ?? '')
      firstPage.set(locale, pages.units[0]?.text ?? '')
    }
    expect(new Set(firstPage.values()).size).toBe(3)
  })

  test('French content follows French typography: a no-break space before : ; ? ! % and inside « »', () => {
    const fr: Readonly<Record<string, unknown>> = catalogs.fr.today
    for (const [key, value] of Object.entries(fr)) {
      if (!key.startsWith('demo') || typeof value !== 'string') continue
      // Code and maths keep their own spacing.
      const prose = value.replace(/```[\s\S]*?```|`[^`]*`|\$\$[\s\S]*?\$\$|\$[^$]*\$/g, '')
      expect([key, prose.match(/ [:;?!%»]|« /g)]).toEqual([key, null])
    }
  })

  test('the content is translated in every catalog: each demo text differs from the English one', () => {
    const same: Readonly<Record<'de' | 'fr', readonly string[]>> = {
      de: ['demoSecTransport'],
      fr: ['demoSecMembranes', 'demoSecStructure', 'demoSecTransport'],
    }
    const en: Readonly<Record<string, unknown>> = catalogs.en.today
    const keys = Object.keys(en).filter((k) => k.startsWith('demo'))
    expect(keys.length).toBeGreaterThan(90)
    for (const locale of ['de', 'fr'] as const) {
      const table: Readonly<Record<string, unknown>> = catalogs[locale].today
      const left = keys.filter((k) => table[k] === en[k] && !same[locale].includes(k))
      expect([locale, left]).toEqual([locale, []])
    }
  })

  test('under the pseudo-locale, the content is the English one, and the course is made whole', async () => {
    const { ws, store, clock } = make(15)
    const id = await createDemoCourse({ ws, store, clock }, await demoTranslator('pseudo'))
    expect(ws.courses.get(id)?.title).toBe('Demo: Cell biology')
    expect(ws.courses.get(id)?.language).toBeUndefined()
    expect(ws.cards.list({ courseId: id }).length).toBe(16)
    expect(ws.drafts.all()).toEqual([])
    expect((await demoTranslator('de'))('today.demoCourse')).toBe('Demo: Zellbiologie')
  })
})
