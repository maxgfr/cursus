import { describe, expect, test } from 'bun:test'
import { seededRng } from '../ports/rng'
import { equalBytes, GUARD_KEY, guardOf } from './guard'
import { memoryStore } from './memoryStore'

const ITER = 1000
const setup = () => {
  const store = memoryStore()
  return { store, guard: guardOf(store, seededRng(7), ITER) }
}

describe('guard', () => {
  test('absent by default', async () => {
    const { guard } = setup()
    expect(await guard.isSet()).toBe(false)
    expect(await guard.verify('anything')).toBe(false)
  })

  test('set then verify right and wrong', async () => {
    const { guard } = setup()
    await guard.set('correct horse')
    expect(await guard.isSet()).toBe(true)
    expect(await guard.verify('correct horse')).toBe(true)
    expect(await guard.verify('correct hors')).toBe(false)
    expect(await guard.verify('')).toBe(false)
  })

  test('rejects a short password and a second set', async () => {
    const { guard } = setup()
    await expect(guard.set('12345')).rejects.toThrow(RangeError)
    expect(await guard.isSet()).toBe(false)
    await guard.set('123456')
    await expect(guard.set('another one')).rejects.toThrow()
    expect(await guard.verify('123456')).toBe(true)
  })

  test('change needs the current password', async () => {
    const { guard } = setup()
    await guard.set('first-pass')
    expect(await guard.change('wrong-pass', 'second-pass')).toBe(false)
    expect(await guard.verify('first-pass')).toBe(true)
    expect(await guard.change('first-pass', 'second-pass')).toBe(true)
    expect(await guard.verify('first-pass')).toBe(false)
    expect(await guard.verify('second-pass')).toBe(true)
  })

  test('remove needs the current password', async () => {
    const { guard } = setup()
    await guard.set('first-pass')
    expect(await guard.remove('nope-nope')).toBe(false)
    expect(await guard.isSet()).toBe(true)
    expect(await guard.remove('first-pass')).toBe(true)
    expect(await guard.isSet()).toBe(false)
  })

  test('the stored value holds no plaintext', async () => {
    const { store, guard } = setup()
    await guard.set('plaintext-secret')
    const json = JSON.stringify(await store.read(['kv'], (tx) => tx.get<unknown>('kv', GUARD_KEY)))
    expect(json).not.toContain('plaintext-secret')
    expect(json).not.toContain(btoa('plaintext-secret'))
  })

  test('malformed stored data counts as absent', async () => {
    for (const value of [
      'x',
      42,
      { v: 2 },
      { v: 1, kdf: { alg: 'PBKDF2-SHA256', iterations: 1000, salt: '!!' }, iv: 'AAAA', check: 'AAAA' },
      { v: 1, kdf: { alg: 'PBKDF2-SHA256', iterations: 0, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }, iv: '', check: '' },
      { v: 1, kdf: { alg: 'PBKDF2-SHA256', iterations: 1000, salt: 'AAAA' }, iv: 'AAAAAAAAAAAAAAAA', check: 'AAAA' },
    ]) {
      const { store, guard } = setup()
      await store.commit([{ put: 'kv', key: GUARD_KEY, value }])
      expect(await guard.isSet()).toBe(false)
      expect(await guard.verify('anything')).toBe(false)
      // A fresh password can be set over it.
      await guard.set('fresh-pass')
      expect(await guard.verify('fresh-pass')).toBe(true)
    }
  })

  test('equalBytes', () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false)
  })
})
