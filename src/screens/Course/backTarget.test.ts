import { expect, test } from 'bun:test'
import { backTarget } from './backTarget.ts'

test('Back returns to the screen the course was opened from, skipping its own cards and sources', () => {
  expect(backTarget(['/courses', '/'])).toBe('/')
  expect(backTarget(['/', '/course/a', '/card/x', '/course/a'])).toBe('/')
  expect(backTarget(['/stats', '/source/s'])).toBe('/stats')
})

test('without an earlier screen, Back goes to Courses', () => {
  expect(backTarget([])).toBe('/courses')
  expect(backTarget(['/card/x'])).toBe('/courses')
})
