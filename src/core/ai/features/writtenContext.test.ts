import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { createWorkspace } from '../../model/workspace'
import { virtualClock } from '../../ports/clock'
import { seededRng } from '../../ports/rng'
import { estimateTokens } from '../retrieval'
import { LIGHT_CHARS, readWritten, type WrittenCard, type WrittenSheet, writtenChunks } from './writtenContext'

const card = (id: string, near: boolean, front = `Q ${id}`, back = `A ${id}`): WrittenCard => ({
  id,
  kind: 'basic',
  front,
  back,
  near,
})
const sheet = (id: string, near: boolean, body = `Body ${id}`): WrittenSheet => ({
  id,
  title: `Sheet ${id}`,
  body,
  keyPoints: [],
  near,
})
const ids = (w: { chunks: { sourceId: string }[] }) => [...new Set(w.chunks.map((c) => c.sourceId))]
const BIG = 100_000

describe('what the student wrote, for the chat', () => {
  test('a section first gives its own cards and sheets, then the rest of the course', () => {
    const w = writtenChunks(
      {
        cards: [card('far1', false), card('near1', true), card('near2', true)],
        sheets: [sheet('s-far', false), sheet('s-near', true)],
      },
      BIG,
    )
    expect(ids(w)).toEqual(['near1', 'near2', 's-near', 'far1', 's-far'])
    expect(w.omitted).toBe(0)
    expect(w.chunks[0]?.text).toBe('Card question: Q near1\nCard answer: A near1')
    expect(w.chunks[2]?.text).toBe('Study sheet: Sheet s-near\n\nBody s-near')
  })

  test('a card on screen comes first in full, its section’s other cards cut short, nothing from elsewhere', () => {
    const long = 'x'.repeat(LIGHT_CHARS * 3)
    const w = writtenChunks(
      {
        card: { id: 'here', hidden: false },
        cards: [card('sib', true, long, long), card('here', true, long, long), card('far', false)],
        sheets: [sheet('s-far', false)],
      },
      BIG,
    )
    expect(ids(w)).toEqual(['here', 'sib'])
    expect(w.chunks[0]?.text).toContain(long)
    expect(w.chunks[1]?.text).not.toContain(long)
    expect(w.chunks[1]?.text).toContain(`${'x'.repeat(LIGHT_CHARS)}…`)
  })

  test('before the reveal the card on screen is left out: only its section’s other cards go', () => {
    const w = writtenChunks(
      { card: { id: 'here', hidden: true }, cards: [card('here', true), card('sib', true)], sheets: [] },
      BIG,
    )
    expect(ids(w)).toEqual(['sib'])
    expect(JSON.stringify(w.chunks)).not.toContain('A here')
  })

  test('a cloze card reads with its deletions filled in, and its extra', () => {
    const w = writtenChunks(
      {
        cards: [
          {
            id: 'c',
            kind: 'cloze',
            front: 'The {{c1::heart::organ}} pumps {{c2::blood}}.',
            back: 'Cardio',
            near: true,
          },
        ],
        sheets: [],
      },
      BIG,
    )
    expect(w.chunks[0]?.text).toBe('Cloze card: The heart pumps blood.\nExtra: Cardio')
  })

  test('within the budget, in order: the first passage that does not fit is cut, the rest counted as left out', () => {
    const cards = Array.from({ length: 30 }, (_, i) => card(`c${i}`, true, 'q'.repeat(400), 'a'.repeat(400)))
    const budget = 1000
    const w = writtenChunks({ cards, sheets: [sheet('s', true)] }, budget)
    const used = w.chunks.reduce((n, c) => n + estimateTokens(c.text) + 16, 0)
    expect(used).toBeLessThanOrEqual(budget)
    const kept = ids(w)
    expect(kept).toEqual(cards.slice(0, kept.length).map((c) => c.id))
    expect(w.chunks.at(-1)?.text.endsWith('…')).toBe(true)
    // The cut card counts as left out, with everything after it.
    expect(w.omitted).toBe(31 - kept.length + 1)
  })

  test('a long sheet is split into passages, all citing it', () => {
    const w = writtenChunks({ cards: [], sheets: [sheet('s', true, 'y'.repeat(4500))] }, BIG)
    expect(w.chunks.length).toBe(3)
    expect(ids(w)).toEqual(['s'])
  })

  test('an empty section, or blank cards, give nothing', () => {
    expect(writtenChunks({ cards: [], sheets: [] }, BIG)).toEqual({ chunks: [], omitted: 0 })
    expect(writtenChunks({ cards: [card('blank', true, ' ', '')], sheets: [] }, BIG).chunks).toEqual([])
    expect(writtenChunks({ cards: [card('a', true)], sheets: [] }, 0)).toEqual({ chunks: [], omitted: 1 })
  })
})

describe('reading what the student wrote from the workspace', () => {
  function setup() {
    const clock = virtualClock(1_800_000_000_000)
    const ws = createWorkspace(new Y.Doc(), { rng: seededRng(7, clock), clock, deviceId: 'd' })
    const courseId = ws.courses.create({ title: 'Physiology' })
    const cardio = ws.sections.create({ courseId, name: 'Cardio' })
    const valves = ws.sections.create({ courseId, name: 'Valves', parentId: cardio })
    const neuro = ws.sections.create({ courseId, name: 'Neuro' })
    const write = (id: string, field: 'front' | 'back' | 'body', text: string) => ws.text({ id, field }).insert(0, text)
    const newCard = (front: string, back: string, sectionId?: string) => {
      const id = ws.cards.create({ courseId, kind: 'basic', ...(sectionId ? { sectionId } : {}) })
      write(id, 'front', front)
      write(id, 'back', back)
      return id
    }
    const heart = newCard('What pumps blood?', 'The heart', cardio)
    const mitral = newCard('Valve between left atrium and ventricle?', 'Mitral', valves)
    const neuron = newCard('Unit of the nervous system?', 'Neuron', neuro)
    const ficheId = ws.fiches.create({ courseId, title: 'Heart sheet', sectionId: cardio })
    write(ficheId, 'body', 'The heart has four chambers.')
    return { ws, courseId, cardio, heart, mitral, neuron, ficheId }
  }

  test('a section holds its subsections; the rest of the course is far', () => {
    const { ws, courseId, cardio, heart, mitral, neuron, ficheId } = setup()
    const place = readWritten(ws, { courseId, sectionId: cardio })
    const near = (id: string) => [...place.cards, ...place.sheets].find((x) => x.id === id)?.near
    expect([near(heart), near(mitral), near(ficheId), near(neuron)]).toEqual([true, true, true, false])
    expect(place.sheets[0]?.body).toBe('The heart has four chambers.')
    expect(ids(writtenChunks(place, BIG))).toEqual([heart, mitral, ficheId, neuron])
  })

  test('around a card, only the cards and sheets of its own section are near', () => {
    const { ws, courseId, cardio, heart, mitral, ficheId } = setup()
    const place = readWritten(ws, { courseId, sectionId: cardio }, { id: heart, hidden: false })
    expect(ids(writtenChunks(place, BIG))).toEqual([heart, ficheId])
    expect(place.cards.find((c) => c.id === mitral)?.near).toBe(false)
  })

  test('a course with only photos has nothing written', () => {
    const clock = virtualClock(1)
    const ws = createWorkspace(new Y.Doc(), { rng: seededRng(3, clock), clock, deviceId: 'd' })
    const courseId = ws.courses.create({ title: 'Photos only' })
    ws.sources.create({ courseId, kind: 'image', title: 'Board', blobId: 'abc' })
    expect(writtenChunks(readWritten(ws, { courseId }), BIG)).toEqual({ chunks: [], omitted: 0 })
  })
})
