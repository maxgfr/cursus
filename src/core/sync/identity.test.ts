import { expect, test } from 'bun:test'
import { destinationId, normalizePrefix, syncLockName } from './identity'

test('identity = hash(type, endpoint, bucket, prefix): any change makes a new destination', () => {
  const base = { type: 's3', endpoint: 'https://s3.example.com', bucket: 'b', prefix: 'cursus' }
  const id = destinationId(base)
  expect(id).toMatch(/^s3-[0-9a-f]{16}$/)
  expect(destinationId({ ...base })).toBe(id)
  expect(destinationId({ ...base, endpoint: 'https://S3.example.com/' })).toBe(id)
  expect(destinationId({ ...base, prefix: '/cursus/' })).toBe(id)
  for (const change of [
    { type: 'gdrive' },
    { endpoint: 'https://other' },
    { bucket: 'c' },
    { prefix: 'cursus-sealed' },
  ]) {
    expect(destinationId({ ...base, ...change })).not.toBe(id)
  }
  expect(destinationId({ type: 'memory' })).toBe(destinationId({ type: 'memory', prefix: '' }))
  expect(() => destinationId({ type: 'Bad Type' })).toThrow(RangeError)
})

test('prefix normalisation and lock names', () => {
  expect(normalizePrefix('//a//b/')).toBe('a/b')
  expect(normalizePrefix()).toBe('')
  expect(syncLockName('s3-1')).toBe('cursus:sync:s3-1')
})
