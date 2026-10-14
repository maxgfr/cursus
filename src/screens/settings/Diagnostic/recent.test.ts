import { expect, test } from 'bun:test'
import { noteError, recentErrors } from './recent.ts'

test('failures keep their technical detail for the report, capped', () => {
  noteError('course.import', new TypeError('pdf.js exploded'))
  expect(recentErrors().at(-1)).toContain('course.import TypeError: pdf.js exploded')
  for (let i = 0; i < 60; i++) noteError('x', i)
  expect(recentErrors()).toHaveLength(50)
})
