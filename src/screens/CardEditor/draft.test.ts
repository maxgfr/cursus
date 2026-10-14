import { expect, test } from 'bun:test'
import { draftKey, newCardCourse, newCardId, sameFields } from './draft.ts'

test('a new card is only a route id until Save: it names its course', () => {
  expect(newCardCourse(newCardId('c1'))).toBe('c1')
  expect(newCardCourse('card-123')).toBeNull()
  expect(draftKey('x')).toBe('draft:card:x')
})

test('a draft is unsaved while any field differs', () => {
  const a = { kind: 'basic' as const, front: 'a', back: 'b' }
  expect(sameFields(a, { ...a })).toBe(true)
  expect(sameFields(a, { ...a, kind: 'cloze' })).toBe(false)
  expect(sameFields(a, { ...a, back: '' })).toBe(false)
})
