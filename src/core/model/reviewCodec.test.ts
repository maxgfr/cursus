import { describe, expect, test } from 'bun:test'
import type { Review } from '../contracts/workspace'
import { decodeEvent, encodeEvent, ReviewDecodeError } from './reviewCodec'

const base = { id: 'r1', cardId: 'c1', rating: 3, at: 1_700_000_000_123, ms: 4_000, dev: 'devA' } as const

/** The error `decodeEvent` throws for `s` (fails the test when it decodes). */
function failure(s: unknown, index = 7): ReviewDecodeError {
  try {
    decodeEvent(s, index)
  } catch (e) {
    if (e instanceof ReviewDecodeError) return e
    throw e
  }
  throw new Error(`decoded ${String(s)}`)
}

describe('review codec', () => {
  const cases: [string, Review][] = [
    ['plain review', { ...base }],
    ['in a session', { ...base, sid: 's1' }],
    ['practice in a session', { ...base, sid: 's1', p: true }],
    ['practice without a session', { ...base, p: true }],
    ['zero time, lapse', { ...base, rating: 1, ms: 0 }],
    ['void', { id: 'v1', voids: 'r1' }],
    ['ids with quotes, newlines and non-ASCII', { ...base, id: 'a"b\nc', cardId: 'carte-é-🃏', dev: 'd\\e' }],
  ]
  for (const [name, e] of cases)
    test(`round-trips: ${name}`, () => {
      const back = decodeEvent(encodeEvent(e), 0)
      expect(back).toEqual(e)
      // No key left undefined: the same keys, in the same order, as the event written the legacy way.
      expect(Object.keys(back)).toEqual(Object.keys(e))
    })

  test('a review is a tuple without its keys', () => {
    expect(encodeEvent({ ...base })).toBe('[1,"r1","c1",3,1700000000123,4000,"devA"]')
    expect(encodeEvent({ ...base, p: true })).toBe('[1,"r1","c1",3,1700000000123,4000,"devA",0,1]')
    expect(encodeEvent({ id: 'v1', voids: 'r1' })).toBe('[2,"v1","r1"]')
    expect(encodeEvent({ ...base }).length).toBeLessThan(JSON.stringify(base).length * 0.7)
  })

  test('an unknown tag is a version error, never a skipped event', () => {
    const e = failure('[3,"r1","c1",3,1,1,"d"]', 12)
    expect(e.kind).toBe('version')
    expect(e.index).toBe(12)
    expect(e.message).toContain('review log event 12')
    expect(failure('[1.5,"r1"]').kind).toBe('version')
  })

  const garbled: [string, unknown][] = [
    ['not a string', { id: 'r1' }],
    ['truncated JSON', '[1,"r1","c1",3,17'],
    ['not a tuple', '{"id":"r1"}'],
    ['an empty tuple', '[]'],
    ['a tag that is not a number', '["1","r1","c1",3,1,1,"d"]'],
    ['a review missing its device', '[1,"r1","c1",3,1,1]'],
    ['a rating out of range', '[1,"r1","c1",5,1,1,"d"]'],
    ['a fractional rating', '[1,"r1","c1",2.5,1,1,"d"]'],
    ['a time that is not a number', '[1,"r1","c1",3,null,1,"d"]'],
    ['an answer time that is not a number', '[1,"r1","c1",3,1,"1","d"]'],
    ['a numeric id', '[1,7,"c1",3,1,1,"d"]'],
    ['a numeric card', '[1,"r1",7,3,1,1,"d"]'],
    ['a numeric device', '[1,"r1","c1",3,1,1,7]'],
    ['a session id that is neither a string nor 0', '[1,"r1","c1",3,1,1,"d",false]'],
    ['a practice flag other than 1', '[1,"r1","c1",3,1,1,"d","s1",true]'],
    ['an unknown extra field', '[1,"r1","c1",3,1,1,"d","s1",1,"x"]'],
    ['a void without its target', '[2,"v1"]'],
    ['a void with a numeric target', '[2,"v1",3]'],
    ['a void with an extra field', '[2,"v1","r1","x"]'],
  ]
  for (const [name, s] of garbled)
    test(`garbled: ${name} is a visible error`, () => {
      const e = failure(s)
      expect(e).toBeInstanceOf(ReviewDecodeError)
      expect(e.kind).toBe('malformed')
      expect(e.index).toBe(7)
      expect(e.name).toBe('ReviewDecodeError')
    })
})
