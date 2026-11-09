import { describe, expect, test } from 'bun:test'
import {
  type ClozeToken,
  clozeFaces,
  clozePlain,
  clozeSpans,
  clozeTokens,
  makeClozeCards,
  toggleClozeToken,
} from './cloze'

/** The text after tapping the token reading `word`. */
function tap(text: string, word: string): string {
  const token = clozeTokens(text).find(
    (x): x is Exclude<ClozeToken, { kind: 'text' }> => x.kind !== 'text' && x.text === word,
  )
  if (!token) throw new Error(`no token ${word}`)
  return toggleClozeToken(text, token)
}

describe('tapping the words of a cloze text', () => {
  test('words, blanks and what lies between, in order and whole', () => {
    expect(clozeTokens('The {{c1::cell::hint}} wall, 3.5 nm!')).toEqual([
      { kind: 'word', text: 'The', from: 0, to: 3 },
      { kind: 'text', text: ' ' },
      { kind: 'blank', text: 'cell', from: 4, to: 22 },
      { kind: 'text', text: ' ' },
      { kind: 'word', text: 'wall', from: 23, to: 27 },
      { kind: 'text', text: ', ' },
      { kind: 'word', text: '3.5', from: 29, to: 32 },
      { kind: 'text', text: ' ' },
      { kind: 'word', text: 'nm', from: 33, to: 35 },
      { kind: 'text', text: '!' },
    ])
  })

  test('an apostrophe ends a word, a hyphen does not', () => {
    const words = clozeTokens("l’osmose d'eau semi-perméable").flatMap((x) => (x.kind === 'word' ? [x.text] : []))
    expect(words).toEqual(['l', 'osmose', 'd', 'eau', 'semi-perméable'])
  })

  test('markup is never cut: pictures disappear, links, code and formulas stay as they are', () => {
    const tokens = clozeTokens('![a b](photo:1) [link text](http://x.y) `co de` $a b$ https://a.b/c')
    expect(tokens.filter((x) => x.kind !== 'text')).toEqual([])
    expect(tokens.map((x) => x.text).join('')).toBe(' [link text](http://x.y) `co de` $a b$ https://a.b/c')
  })

  test('a word becomes the next blank, numbers already used stay', () => {
    expect(tap('The cell holds DNA', 'cell')).toBe('The {{c1::cell}} holds DNA')
    expect(tap('The {{c3::cell}} holds DNA', 'DNA')).toBe('The {{c3::cell}} holds {{c4::DNA}}')
  })

  test('a blank shows its word again, its hint gone', () => {
    expect(tap('The {{c1::cell::hint}} wall', 'cell')).toBe('The cell wall')
  })

  test('a word next to a blank joins it, on either side, not across a line or another word', () => {
    expect(tap('The {{c1::cell}} wall', 'wall')).toBe('The {{c1::cell wall}}')
    expect(tap('The cell {{c1::wall::hint}}', 'cell')).toBe('The {{c1::cell wall::hint}}')
    expect(tap('{{c1::cell}}\nwall', 'wall')).toBe('{{c1::cell}}\n{{c2::wall}}')
    expect(tap('{{c1::cell}} big wall', 'wall')).toBe('{{c1::cell}} big {{c2::wall}}')
  })

  test('joined or not, the result is a valid card', () => {
    const joined = tap(tap('The cell wall', 'cell'), 'wall')
    expect(makeClozeCards(joined)).toEqual([{ index: 1, front: 'The [...]', back: 'The cell wall' }])
  })
})

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
