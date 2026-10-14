import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { blobStore } from '../log/blobs'
import { createWorkspace } from '../model/workspace'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { DAY_MS } from '../srs/fsrs'
import { memoryStore } from '../storage/memoryStore'
import { importApkg, readApkg } from './apkgRead'
import { exportApkg } from './apkgWrite'

const T0 = 1_750_000_000_000

function setup(seed: number) {
  const clock = virtualClock(T0)
  const ws = createWorkspace(new Y.Doc(), { rng: seededRng(seed, clock), clock, deviceId: 'dev' })
  return { ws, blobs: blobStore(memoryStore()) }
}

async function sample() {
  const s = setup(1)
  const { ws, blobs } = s
  const png = await blobs.put(new Uint8Array([137, 80, 78, 71]), 'image/png')
  const mp3 = await blobs.put(new Uint8Array([73, 68, 51]), 'audio/mpeg')
  const course = ws.courses.create({ title: 'Physics' })
  const basic = ws.cards.create({ courseId: course, kind: 'basic', tags: ['phys'] })
  ws.text({ id: basic, field: 'front' }).insert(0, `**Energy** of mass $E = mc^2$\n\n![](cursus-blob:${png})`)
  ws.text({ id: basic, field: 'back' }).insert(0, '$$a < b$$')
  const cloze = ws.cards.create({ courseId: course, kind: 'cloze' })
  ws.text({ id: cloze, field: 'front' }).insert(
    0,
    `Light is {{c2::fast}} <audio controls src="cursus-blob:${mp3}"></audio>`,
  )
  ws.text({ id: cloze, field: 'back' }).insert(0, '')
  ws.reviews.record({ cardId: basic, rating: 3, at: T0, ms: 5_000 })
  ws.reviews.record({ cardId: basic, rating: 3, at: T0 + 600_000, ms: 90_000 })
  ws.reviews.record({ cardId: basic, rating: 4, at: T0 + DAY_MS, ms: 2_000 })
  return { ...s, course, basic, cloze }
}

describe('exportApkg', () => {
  test('writes a schema 11 package with notetypes, decks, media and revlog', async () => {
    const { ws, blobs } = await sample()
    const bytes = await exportApkg(ws, blobs, { now: T0 + 2 * DAY_MS })
    const { format, collection, media } = await readApkg(bytes)
    expect(format).toBe('anki2')
    expect([...collection.notetypes.values()].map((t) => [t.name, t.kind, t.fields])).toEqual([
      ['Cursus Basic', 'normal', ['Front', 'Back']],
      ['Cursus Cloze', 'cloze', ['Text', 'Back Extra']],
    ])
    expect([...collection.decks.values()].map((d) => d.join('::')).sort()).toEqual([
      'Cursus',
      'Cursus::Physics',
      'Default',
    ])
    const notes = [...collection.notes.values()]
    expect(notes[0]?.fields[0]).toMatch(
      /^<p><strong>Energy<\/strong> of mass \\\(E = mc\^2\\\)<\/p>\n<p><img src="cursus-[0-9a-f]{16}\.png" alt=""><\/p>$/,
    )
    expect(notes[0]?.fields[1]).toBe('\\[a &lt; b\\]')
    expect(notes[0]?.tags).toEqual(['phys'])
    expect(notes[1]?.fields[0]).toMatch(/^Light is \{\{c2::fast\}\} \[sound:cursus-[0-9a-f]{16}\.mp3\]$/)
    expect(collection.cards.map((c) => c.ord)).toEqual([0, 1])
    expect(collection.revlog.map((r) => [r.ease, r.type, r.time])).toEqual([
      [3, 0, 5_000],
      [3, 0, 60_000],
      [4, 1, 2_000],
    ])
    expect([...media.keys()].map((k) => k.split('.')[1]).sort()).toEqual(['mp3', 'png'])
  })

  test('round-trips through import, and re-importing our own export adds nothing', async () => {
    const { ws, blobs, basic } = await sample()
    const bytes = await exportApkg(ws, blobs, { now: T0 + 2 * DAY_MS })
    expect(await importApkg(bytes, ws, blobs)).toMatchObject({ imported: 0, skipped: 2 })

    const other = setup(2)
    const res = await importApkg(bytes, other.ws, other.blobs)
    expect(res).toMatchObject({ imported: 2, reviews: 3, media: 2 })
    expect(other.ws.courses.list().map((c) => c.title)).toEqual(['Physics'])
    const b = other.ws.cards.list().find((x) => x.kind === 'basic')
    const c = other.ws.cards.list().find((x) => x.kind === 'cloze')
    if (!b || !c) throw new Error('missing cards')
    expect(other.ws.text({ id: b.id, field: 'front' }).toString()).toBe(
      ws.text({ id: basic, field: 'front' }).toString(),
    )
    expect(other.ws.text({ id: b.id, field: 'back' }).toString()).toBe('$$a < b$$')
    expect(other.ws.text({ id: c.id, field: 'front' }).toString()).toMatch(/^Light is \{\{c2::fast\}\} <audio/)
    expect(other.ws.reviews.forCard(b.id).map((r) => ('rating' in r ? r.rating : 0))).toEqual([3, 3, 4])
  })

  test('respects course selection and withHistory', async () => {
    const { ws, blobs } = await sample()
    ws.courses.create({ title: 'Empty' })
    const bytes = await exportApkg(ws, blobs, { now: T0, courseIds: [], withHistory: false })
    const { collection } = await readApkg(bytes)
    expect(collection.cards).toHaveLength(0)
    expect(collection.revlog).toHaveLength(0)
  })

  test('one deck per subset, round-tripping to the same tree', async () => {
    const { ws, blobs } = setup(3)
    const course = ws.courses.create({ title: 'Law' })
    const contracts = ws.sections.create({ courseId: course, name: 'Contracts' })
    const formation = ws.sections.create({ courseId: course, parentId: contracts, name: 'Formation::Offer' })
    ws.sections.create({ courseId: course, name: 'Empty' })
    const gone = ws.sections.create({ courseId: course, name: 'Gone' })
    const add = (front: string, sectionId?: string) => {
      const id = ws.cards.create({ courseId: course, kind: 'basic', ...(sectionId ? { sectionId } : {}) })
      ws.text({ id, field: 'front' }).insert(0, front)
      ws.text({ id, field: 'back' }).insert(0, 'x')
      return id
    }
    add('root')
    add('c', contracts)
    add('f1', formation)
    add('f2', formation)
    add('hidden', gone)
    ws.sections.trash(gone)
    const bytes = await exportApkg(ws, blobs, { now: T0 })
    const { collection } = await readApkg(bytes)
    const names = (did: number) => collection.decks.get(did)?.join('::')
    expect([...collection.decks.values()].map((d) => d.join('::')).sort()).toEqual([
      'Cursus',
      'Cursus::Law',
      'Cursus::Law::Contracts',
      'Cursus::Law::Contracts::Formation:Offer',
      'Cursus::Law::Empty',
      'Default',
    ])
    const perDeck = new Map<string, number>()
    for (const c of collection.cards) perDeck.set(names(c.did) ?? '', (perDeck.get(names(c.did) ?? '') ?? 0) + 1)
    expect(Object.fromEntries(perDeck)).toEqual({
      'Cursus::Law': 1,
      'Cursus::Law::Contracts': 1,
      'Cursus::Law::Contracts::Formation:Offer': 2,
    })

    const other = setup(4)
    await importApkg(bytes, other.ws, other.blobs)
    const tree = other.ws.sections.tree()
    const paths = other.ws.cards
      .list()
      .map((c) => [other.ws.text({ id: c.id, field: 'front' }).toString(), tree.pathOf(c)])
      .sort()
    expect(paths).toEqual([
      ['c', 'Contracts'],
      ['f1', 'Contracts › Formation:Offer'],
      ['f2', 'Contracts › Formation:Offer'],
      ['root', ''],
    ])
  })
})
