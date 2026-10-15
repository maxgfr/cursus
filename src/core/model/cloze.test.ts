import { describe, expect, test } from 'bun:test'
import { clozeFaces, clozePlain, clozeSpans, makeClozeCards } from './cloze'

describe('cloze', () => {
  test('one card per index, hints, shared index', () => {
    const cards = makeClozeCards('{{c1::Paris}} is in {{c2::France::country}}, {{c1::Paris}} again')
    expect(cards).toEqual([
      { index: 1, front: '[...] is in France, [...] again', back: 'Paris is in France, Paris again' },
      { index: 2, front: 'Paris is in [country], Paris again', back: 'Paris is in France, Paris again' },
    ])
  })

  test('no cloze yields no cards', () => {
    expect(makeClozeCards('plain')).toEqual([])
  })

  test('spans locate each deletion and its answer, hint excluded', () => {
    const text = 'A {{c1::Paris}} and {{c12::France::country}}.'
    const spans = clozeSpans(text)
    expect(spans).toEqual([
      { index: 1, from: 2, to: 15, answerFrom: 8, answerTo: 13 },
      { index: 12, from: 20, to: 44, answerFrom: 27, answerTo: 33 },
    ])
    expect(spans.map((s) => text.slice(s.answerFrom, s.answerTo))).toEqual(['Paris', 'France'])
    expect(spans.map((s) => text.slice(s.from, s.to))).toEqual(['{{c1::Paris}}', '{{c12::France::country}}'])
  })

  test('an empty answer is still a deletion; plain text has none', () => {
    expect(clozeSpans('plain {{c1::}} {c1::x}')).toEqual([{ index: 1, from: 6, to: 14, answerFrom: 12, answerTo: 12 }])
    expect(clozeSpans('plain')).toEqual([])
  })

  test('faces as reviewed: every deletion marked, the asked one as [...] or its hint on the front', () => {
    const text = '{{c1::Paris}} is in {{c2::France::country}}.'
    expect(clozeFaces(text, 2)).toEqual({
      front: '<mark class="cloze">Paris</mark> is in <mark class="cloze">[country]</mark>.',
      back: '<mark class="cloze">Paris</mark> is in <mark class="cloze">France</mark>.',
    })
    expect(clozeFaces(text, 1).front).toBe('<mark class="cloze">[...]</mark> is in <mark class="cloze">France</mark>.')
    expect(clozeFaces('plain', 1)).toEqual({ front: 'plain', back: 'plain' })
  })

  test('as plain text, every deletion reads as its answer, hints dropped', () => {
    expect(clozePlain('{{c1::Paris}} is in {{c2::France::country}}.')).toBe('Paris is in France.')
    expect(clozePlain('no blanks')).toBe('no blanks')
  })
})
