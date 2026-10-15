import { describe, expect, test } from 'bun:test'
import { dedupeDrafts, flagDuplicates, frontKey } from './dedupe'
import type { CardDraft } from './schemas'

const basic = (front: string): CardDraft => ({ kind: 'basic', front, back: 'x' })

describe('duplicate drafts', () => {
  test('fronts compare without case, accents, punctuation or cloze markup', () => {
    expect(frontKey('Où est la Cellule ?')).toBe(frontKey('ou est la cellule'))
    expect(frontKey('The {{c1::stroma::place}} fixes CO2.')).toBe(frontKey('the stroma fixes co2'))
  })

  test('a repeat of an earlier draft or of a card the course has is flagged, in place', () => {
    const drafts = [basic('Where is ATP made?'), basic('where is ATP made'), basic('Known one'), basic('  ')]
    expect(flagDuplicates(drafts, ['Known one!']).map((d) => d.duplicate)).toEqual([false, true, true, true])
  })

  test('dropping keeps the first of each and counts the rest', () => {
    const { kept, dropped } = dedupeDrafts([basic('A?'), basic('a'), basic('B?')], [])
    expect(kept).toEqual([basic('A?'), basic('B?')])
    expect(dropped).toBe(1)
  })
})
