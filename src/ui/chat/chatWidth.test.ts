import { describe, expect, test } from 'bun:test'
import { chatExpanded, parseExpanded, setChatExpanded } from './chatWidth.ts'

describe('the chat expanded or restored, as last chosen on this device', () => {
  test('only a restore remembered opens the column; nothing or anything else, expanded', () => {
    expect(parseExpanded('0')).toBe(false)
    expect(parseExpanded('1')).toBe(true)
    expect(parseExpanded(null)).toBe(true)
    expect(parseExpanded('')).toBe(true)
    expect(parseExpanded('restored')).toBe(true)
  })

  test('without storage, it opens expanded and a choice is not an error', () => {
    expect(() => setChatExpanded(false)).not.toThrow()
    expect(chatExpanded()).toBe(true)
  })
})
