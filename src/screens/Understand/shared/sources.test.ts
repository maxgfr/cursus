import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { blobStore } from '../../../core/log/blobs'
import type { SourceRecord } from '../../../core/model/schema'
import { createWorkspace } from '../../../core/model/workspace'
import { virtualClock } from '../../../core/ports/clock'
import { seededRng } from '../../../core/ports/rng'
import { memoryStore } from '../../../core/storage/memoryStore'
import { chunksFor, type DeckReader } from './sources'

function setup() {
  const clock = virtualClock(1_000)
  const ws = createWorkspace(new Y.Doc(), { rng: seededRng(7, clock), clock, deviceId: 'dev' })
  const courseId = ws.courses.create({ title: 'Biology' })
  return { ws, courseId, blobs: blobStore(memoryStore()) }
}

const SLIDES = [
  { index: 1, title: 'Cell Biology 101', text: '' },
  { index: 2, title: 'Osmosis', text: '- Water crosses a membrane', notes: 'Stress that water moves, not solutes.' },
  { index: 3, title: 'Transport compared', text: '| Passive | Active |' },
]

describe('chunksFor', () => {
  test('a deck or document source gives the text of each unit, numbered for citations', async () => {
    const { ws, courseId, blobs } = setup()
    const deck = ws.sources.create({ courseId, kind: 'note', support: 'deck', title: 'Slides', blobId: 'b1' })
    const doc = ws.sources.create({ courseId, kind: 'note', support: 'document', title: 'Notes', blobId: 'b2' })
    const read: string[] = []
    const readDeck: DeckReader = async (s: SourceRecord) => {
      read.push(s.title)
      return s.id === deck ? SLIDES : [{ index: 1, title: '1.1 Diffusion', text: 'Down the gradient.' }]
    }
    const chunks = await chunksFor(ws, blobs, [deck, doc], '', readDeck)
    expect(read).toEqual(['Slides', 'Notes'])
    expect(chunks).toEqual([
      { sourceId: deck, page: 1, text: 'Cell Biology 101' },
      {
        sourceId: deck,
        page: 2,
        text: 'Osmosis\n\n- Water crosses a membrane\n\nSpeaker notes: Stress that water moves, not solutes.',
      },
      { sourceId: deck, page: 3, text: 'Transport compared\n\n| Passive | Active |' },
      { sourceId: doc, page: 1, text: '1.1 Diffusion\n\nDown the gradient.' },
    ])
  })

  test('a deck whose file is not on this device yet adds nothing; notes still read their body', async () => {
    const { ws, courseId, blobs } = setup()
    const deck = ws.sources.create({ courseId, kind: 'note', support: 'deck', title: 'Slides', blobId: 'b1' })
    const note = ws.sources.create({ courseId, kind: 'note', title: 'Note' })
    ws.text({ id: note, field: 'body' }).insert(0, 'Ribosomes build proteins.')
    const chunks = await chunksFor(ws, blobs, [deck, note], 'Pasted line.', async () => null)
    expect(chunks).toEqual([
      { sourceId: note, text: 'Ribosomes build proteins.' },
      { sourceId: 'pasted', text: 'Pasted line.' },
    ])
  })

  test('a failed read is reported, not hidden', async () => {
    const { ws, courseId, blobs } = setup()
    const deck = ws.sources.create({ courseId, kind: 'note', support: 'deck', title: 'Slides', blobId: 'b1' })
    await expect(
      chunksFor(ws, blobs, [deck], '', async () => {
        throw new Error('corrupt')
      }),
    ).rejects.toThrow('corrupt')
  })
})
