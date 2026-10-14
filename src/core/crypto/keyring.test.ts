import { describe, expect, test } from 'bun:test'
import { seededRng } from '../ports/rng'
import { memoryStore } from '../storage/memoryStore'
import { secretsVault } from '../storage/secrets'
import { deriveKek, fromBase64, PBKDF2_ITERATIONS, randomBytes, toBase64 } from './kdf'
import { createKeyring, keyFileKey, parseEnvelope } from './keyring'

const ITER = 1000

function ring(seed = 1, store = memoryStore(), destId = 'dest-1') {
  return {
    store,
    ring: createKeyring({ secrets: secretsVault(store), destId, rng: seededRng(seed), iterations: ITER }),
  }
}

describe('kdf', () => {
  test('PBKDF2-SHA256 KEK: same passphrase+salt ⇒ same key, other passphrase ⇒ other key', async () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000)
    const salt = randomBytes(seededRng(1), 16)
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
    const iv = new Uint8Array(12)
    const k1 = await deriveKek('café horse', salt, ITER)
    const k2 = await deriveKek('café horse'.normalize('NFD'), salt, ITER)
    const wrapped = await crypto.subtle.wrapKey('raw', dek, k1, { name: 'AES-GCM', iv })
    const back = await crypto.subtle.unwrapKey('raw', wrapped, k2, { name: 'AES-GCM', iv }, 'AES-GCM', true, [
      'encrypt',
    ])
    expect(back.extractable).toBe(true)
    const k3 = await deriveKek('wrong', salt, ITER)
    await expect(
      crypto.subtle.unwrapKey('raw', wrapped, k3, { name: 'AES-GCM', iv }, 'AES-GCM', true, ['encrypt']),
    ).rejects.toThrow()
    expect(k1.extractable).toBe(false)
    await expect(deriveKek('', salt, ITER)).rejects.toThrow(RangeError)
    await expect(deriveKek('x', salt, 0)).rejects.toThrow(RangeError)
  })
  test('base64 and random bytes', () => {
    const b = randomBytes(seededRng(2), 7)
    expect(b.length).toBe(7)
    expect(fromBase64(toBase64(b))).toEqual(b)
    expect(randomBytes(seededRng(2), 7)).toEqual(b)
  })
})

describe('keyring', () => {
  test('create: key file named by its hash; DEK stored non-extractable in secrets; current() uses it', async () => {
    const { ring: r, store } = ring()
    expect(await r.current()).toBeNull()
    const f = await r.create('pass phrase')
    expect(f.key).toBe(keyFileKey(f.body))
    const env = parseEnvelope(f)
    expect(env).toMatchObject({ v: 1, keyId: f.keyId, kdf: { alg: 'PBKDF2-SHA256', iterations: ITER } })
    const cur = await r.current()
    expect(cur?.id).toBe(f.keyId)
    expect(cur?.key.extractable).toBe(false)
    expect(await r.byId(f.keyId)).not.toBeNull()
    expect(await r.byId('0000000000000000')).toBeNull()
    // another session on the same device: no passphrase needed
    const again = createKeyring({ secrets: secretsVault(store), destId: 'dest-1', rng: seededRng(9), iterations: ITER })
    expect((await again.current())?.id).toBe(f.keyId)
    expect((await again.files()).map((x) => x.key)).toEqual([f.key])
  })

  test('a new device unlocks with the right passphrase only', async () => {
    const { ring: a } = ring(1)
    const f = await a.create('right')
    const { ring: b } = ring(2)
    await b.learn([f, { key: 'keys/bogus.json', body: new Uint8Array([1]) }])
    expect((await b.files()).length).toBe(1)
    expect(await b.unlock('wrong')).toBe(0)
    expect(await b.current()).toBeNull()
    expect(await b.unlock('right')).toBe(1)
    expect((await b.current())?.id).toBe(f.keyId)
    expect(await b.unlock('right')).toBe(0)
    await b.learn([f])
    expect((await b.files()).length).toBe(1)
    await b.lock()
    expect(await b.current()).toBeNull()
  })

  test('changing the passphrase adds a key file; both passphrases open their own file (union)', async () => {
    const { ring: a } = ring(1)
    const f1 = await a.create('old')
    const f2 = await a.changePassphrase('old', 'new')
    expect(f2.key).not.toBe(f1.key)
    expect(parseEnvelope(f2)?.keyId).toBe(f1.keyId)
    await expect(a.changePassphrase('nope', 'x')).rejects.toThrow(RangeError)
    for (const pass of ['old', 'new']) {
      const { ring: b } = ring(3)
      await b.learn([f1, f2])
      expect(await b.unlock(pass)).toBe(1)
      expect((await b.current())?.id).toBe(f1.keyId)
    }
  })

  test('the smallest unlocked keyId is used for new uploads', async () => {
    const { ring: a } = ring(1)
    const { ring: c } = ring(4)
    const fa = await a.create('p')
    const fc = await c.create('p')
    const { ring: b } = ring(5)
    await b.learn([fa, fc])
    expect(await b.unlock('p')).toBe(2)
    expect((await b.current())?.id).toBe([fa.keyId, fc.keyId].sort()[0])
  })

  test('parseEnvelope rejects renamed, non-JSON or unknown files', () => {
    const body = new TextEncoder().encode('{"v":2}')
    expect(parseEnvelope({ key: keyFileKey(body), body })).toBeNull()
    const junk = new Uint8Array([0xff])
    expect(parseEnvelope({ key: keyFileKey(junk), body: junk })).toBeNull()
    expect(parseEnvelope({ key: 'keys/x.json', body })).toBeNull()
    const nul = new TextEncoder().encode('null')
    expect(parseEnvelope({ key: keyFileKey(nul), body: nul })).toBeNull()
  })
})
