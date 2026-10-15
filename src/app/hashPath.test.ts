import { expect, test } from 'bun:test'
import { splitHash } from './hashPath.ts'

test('a hash route splits into its path and the query it carries', () => {
  expect(splitHash('#/quiz?course=a&section=b')).toEqual({ path: '/quiz', search: 'course=a&section=b' })
  expect(splitHash('#/course/x')).toEqual({ path: '/course/x', search: '' })
  expect(splitHash('')).toEqual({ path: '/', search: '' })
  expect(splitHash('#')).toEqual({ path: '/', search: '' })
  expect(splitHash('/search?q=offer')).toEqual({ path: '/search', search: 'q=offer' })
  expect(splitHash('settings')).toEqual({ path: '/settings', search: '' })
})
