import { describe, expect, test } from 'bun:test'
import { makeClozeCards } from './cloze'

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
})
