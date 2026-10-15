import { describe, expect, test } from 'bun:test'
import { revealDelta } from './keyboardReveal.ts'

describe('revealDelta', () => {
  const free = { top: 60, bottom: 400 }

  test('a caret already in the free part stays where it is', () => {
    expect(revealDelta({ top: 200, bottom: 220 }, free)).toBe(0)
  })

  test('a caret under the keyboard scrolls down just enough', () => {
    expect(revealDelta({ top: 500, bottom: 520 }, free)).toBe(120)
  })

  test('a caret above the free part (under the header) scrolls up', () => {
    expect(revealDelta({ top: 20, bottom: 40 }, free)).toBe(-40)
  })

  test('a caret taller than the free part shows its top', () => {
    expect(revealDelta({ top: 300, bottom: 900 }, free)).toBe(240)
  })
})
