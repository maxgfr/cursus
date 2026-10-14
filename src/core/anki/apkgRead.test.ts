import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { blobStore } from '../log/blobs'
import { createWorkspace } from '../model/workspace'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { memoryStore } from '../storage/memoryStore'
import { ApkgError, cardSides, courseTitle, importApkg, readApkg } from './apkgRead'

const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(new URL(`../../../tests/fixtures/anki/${name}`, import.meta.url)).arrayBuffer())

function setup() {
  const clock = virtualClock(1_000)
  const ws = createWorkspace(new Y.Doc(), { rng: seededRng(7, clock), clock, deviceId: 'dev' })
  const blobs = blobStore(memoryStore())
  return { ws, blobs }
}

const text = (ws: ReturnType<typeof setup>['ws'], id: string, field: 'front' | 'back') =>
  ws.text({ id, field }).toString()

describe.each(['legacy.apkg', 'modern.apkg'])('import %s', (name) => {
  test('reads the engine-made package', async () => {
    const { format, collection, media } = await readApkg(await fixture(name))
    expect(format).toBe(name === 'modern.apkg' ? 'anki21b' : 'anki21')
    expect(collection.cards).toHaveLength(4)
    expect([...media.keys()].sort()).toEqual(['cell.png', 'hello.mp3'])
    expect(new TextDecoder().decode(media.get('hello.mp3'))).toBe('ID3fake-mp3-bytes')
  })

  test('maps decks, fields, clozes, maths, media and history', async () => {
    const { ws, blobs } = setup()
    const res = await importApkg(await fixture(name), ws, blobs)
    expect(res).toMatchObject({ imported: 4, skipped: 0, reviews: 6, media: 2 })
    expect(ws.courses.list().map((c) => c.title)).toEqual(['Bio::Cells', 'Geo'])
    const [bio, geo] = ws.courses.list()
    const basic = ws.cards.list({ courseId: bio?.id })
    expect(basic.map((c) => c.ankiGuid)).toEqual(expect.arrayContaining(['guidBasic01:0', 'guidBasic01:1']))
    const fwd = basic.find((c) => c.ankiGuid === 'guidBasic01:0')
    const rev = basic.find((c) => c.ankiGuid === 'guidBasic01:1')
    if (!fwd || !rev) throw new Error('missing cards')
    expect(fwd).toMatchObject({ kind: 'basic', origin: 'anki', tags: ['bio', 'cells'] })
    expect(text(ws, fwd.id, 'front')).toMatch(
      /^The \*\*powerhouse\*\* of the cell {2}\n!\[\]\(cursus-blob:[0-9a-f]{64}\)$/,
    )
    expect(text(ws, fwd.id, 'back')).toBe('Mitochondria $E = mc^2$\n\n**Notes:** Has its own DNA')
    expect(text(ws, rev.id, 'front')).toBe('Mitochondria $E = mc^2$')
    expect(text(ws, rev.id, 'back')).toContain('**powerhouse**')

    const clozes = ws.cards.list({ courseId: geo?.id })
    expect(clozes.map((c) => c.kind)).toEqual(['cloze', 'cloze'])
    const fronts = [...clozes]
      .sort((a, b) => String(a.ankiGuid).localeCompare(String(b.ankiGuid)))
      .map((c) => text(ws, c.id, 'front'))
    expect(fronts[0]).toMatch(
      /^\{\{c1::Paris\}\} is the capital of France <audio controls src="cursus-blob:[0-9a-f]{64}"><\/audio>$/,
    )
    expect(fronts[1]).toMatch(/^Paris is the capital of \{\{c2::France\}\} <audio/)
    expect(text(ws, clozes[0]?.id ?? '', 'back')).toBe('**Back Extra:** *Geography*')

    // ease 0 and type 4 rows are dropped; the rest keeps its time and rating.
    expect(ws.reviews.forCard(fwd.id)).toMatchObject([
      { rating: 3, at: 1_700_000_000_000, ms: 4_000 },
      { rating: 3, at: 1_700_086_400_000 },
    ])
    const img = /cursus-blob:([0-9a-f]{64})/.exec(text(ws, fwd.id, 'front'))?.[1] ?? ''
    expect((await blobs.get(img))?.type).toBe('image/png')
  })

  test('re-import adds only new cards', async () => {
    const { ws, blobs } = setup()
    const bytes = await fixture(name)
    await importApkg(bytes, ws, blobs)
    const again = await importApkg(bytes, ws, blobs)
    expect(again).toMatchObject({ imported: 0, skipped: 4, reviews: 0 })
    expect(ws.cards.list()).toHaveLength(4)
    expect(ws.courses.list()).toHaveLength(2)
  })

  test('keepHistory: false imports no reviews', async () => {
    const { ws, blobs } = setup()
    const res = await importApkg(await fixture(name), ws, blobs, { keepHistory: false })
    expect(res.reviews).toBe(0)
    expect(ws.reviews.yArray.length).toBe(0)
  })
})

describe('mapping', () => {
  test('rejects non-zip and empty packages', async () => {
    await expect(readApkg(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(ApkgError)
  })

  test('course titles drop the Cursus root deck', () => {
    expect(courseTitle(['Cursus', 'Bio'])).toBe('Bio')
    expect(courseTitle(['Cursus'])).toBe('Cursus')
    expect(courseTitle(['A', 'B'])).toBe('A::B')
  })

  test('labels extra fields on the back', () => {
    const type = { name: 'T', kind: 'normal' as const, fields: ['F', 'B', 'X', 'Y'] }
    const note = { id: 1, guid: 'g', mid: 1, fields: ['f', 'b', 'x', ''], tags: [] }
    expect(cardSides(note, type, 0)).toEqual({ front: 'f', back: 'b<p><b>X:</b> x</p>' })
    expect(cardSides(note, type, 1)).toEqual({ front: 'b', back: 'f<p><b>X:</b> x</p>' })
  })
})
