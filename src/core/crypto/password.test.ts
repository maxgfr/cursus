import { describe, expect, test } from 'bun:test'
import { seededRng } from '../ports/rng'
import { GUARD_KEY, guardOf } from '../storage/guard'
import { memoryStore } from '../storage/memoryStore'
import { secretsVault } from '../storage/secrets'
import { createKeyring, PASSPHRASE_MIN_LENGTH } from './keyring'
import { changePassword, passwordAsPassphrase } from './password'

const ITER = 1000
const PASSWORD = 'correct horse'

async function setup(password = PASSWORD) {
  const store = memoryStore()
  const guard = guardOf(store, seededRng(7), ITER)
  await guard.set(password)
  const ring = (destId: string, seed: number) =>
    createKeyring({ secrets: secretsVault(store), destId, rng: seededRng(seed), iterations: ITER })
  return { store, guard, ring }
}

/** A keyring on another device that only knows the destination's key files. */
async function stranger(files: Awaited<ReturnType<ReturnType<typeof createKeyring>['files']>>) {
  const other = createKeyring({
    secrets: secretsVault(memoryStore()),
    destId: 'd',
    rng: seededRng(99),
    iterations: ITER,
  })
  await other.learn(files)
  return other
}

describe('the app password as a passphrase', () => {
  test('only the app password, and only a long enough one', async () => {
    const { guard } = await setup()
    expect(PASSPHRASE_MIN_LENGTH).toBe(10)
    expect(await passwordAsPassphrase(guard, PASSWORD)).toBe('ok')
    expect(await passwordAsPassphrase(guard, 'correct hors')).toBe('wrong')
    expect(await passwordAsPassphrase(guard, '')).toBe('wrong')
    const short = await setup('lock-123')
    expect(await passwordAsPassphrase(short.guard, 'lock-123')).toBe('short')
  })

  test('no password set: nothing is a passphrase', async () => {
    const guard = guardOf(memoryStore(), seededRng(7), ITER)
    expect(await passwordAsPassphrase(guard, PASSWORD)).toBe('wrong')
  })

  test('changing it adds a key file under the new password; the old one still opens the old file', async () => {
    const { guard, ring } = await setup()
    const a = ring('a', 1)
    const b = ring('b', 2)
    const keyA = await a.create(PASSWORD)
    await b.create(PASSWORD)
    expect(await changePassword({ guard, rings: [a, b], current: PASSWORD, next: 'battery staple' })).toBe('ok')
    expect(await guard.verify('battery staple')).toBe(true)
    expect(await guard.verify(PASSWORD)).toBe(false)
    for (const r of [a, b]) expect(await r.files()).toHaveLength(2)
    // Another device that learns the files opens the same data key with either password.
    const files = await a.files()
    const fresh = await stranger(files)
    expect(await fresh.unlock('battery staple')).toBe(1)
    expect((await fresh.current())?.id).toBe(keyA.keyId)
    expect(await (await stranger(files)).unlock(PASSWORD)).toBe(1)
  })

  test('a wrong current password or a short new one changes nothing', async () => {
    const { store, guard, ring } = await setup()
    const a = ring('a', 1)
    await a.create(PASSWORD)
    const before = await store.read(['kv'], (tx) => tx.get<unknown>('kv', GUARD_KEY))
    expect(await changePassword({ guard, rings: [a], current: 'nope nope nope', next: 'battery staple' })).toBe('wrong')
    expect(await changePassword({ guard, rings: [a], current: PASSWORD, next: 'short1' })).toBe('short')
    expect(await a.files()).toHaveLength(1)
    expect(await store.read(['kv'], (tx) => tx.get<unknown>('kv', GUARD_KEY))).toEqual(before)
    // With no backup encrypted by it, the password only needs the guard's own minimum.
    expect(await changePassword({ guard, rings: [], current: PASSWORD, next: 'short1' })).toBe('ok')
    expect(await guard.verify('short1')).toBe(true)
  })

  test('a backup the current password does not open keeps the password as it was', async () => {
    const { guard, ring } = await setup()
    const a = ring('a', 1)
    await a.create('another passphrase')
    await expect(changePassword({ guard, rings: [a], current: PASSWORD, next: 'battery staple' })).rejects.toThrow(
      RangeError,
    )
    expect(await guard.verify(PASSWORD)).toBe(true)
    expect(await a.files()).toHaveLength(1)
  })
})
