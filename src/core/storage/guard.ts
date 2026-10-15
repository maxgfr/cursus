import type { LocalStore, Rng } from '../contracts/ports'
import { deriveKek, fromBase64, PBKDF2_ITERATIONS, randomBytes, SALT_BYTES, toBase64 } from '../crypto/kdf'

/**
 * Device-only password that protects destructive actions (store `kv`, never synced, never in the workspace).
 * A lock against accidents and borrowed devices, not encryption: the library itself stays readable.
 * Only a verifier is kept: AES-GCM of a fixed block under a PBKDF2 key from the password and a random salt.
 */
export const GUARD_KEY = 'guard.password'
export const GUARD_MIN_LENGTH = 6

interface GuardRecord {
  v: 1
  kdf: { alg: 'PBKDF2-SHA256'; iterations: number; salt: string }
  iv: string
  check: string
}

export interface Guard {
  /** True when a well-formed password record is stored; a malformed one counts as absent. */
  isSet(): Promise<boolean>
  /** Sets the first password; fails when one is already set (use `change`). */
  set(password: string): Promise<void>
  verify(password: string): Promise<boolean>
  /** Replaces the password; false (nothing changed) when `current` is wrong. */
  change(current: string, next: string): Promise<boolean>
  /** Removes the password; false (nothing removed) when `current` is wrong. */
  remove(current: string): Promise<boolean>
}

const BLOCK = new Uint8Array(new ArrayBuffer(32))
const AAD = new TextEncoder().encode('cursus/1|guard')
const B64 = /^[A-Za-z0-9+/]*={0,2}$/

function parse(x: unknown): GuardRecord | null {
  if (typeof x !== 'object' || x === null) return null
  const r = x as GuardRecord
  const ok =
    r.v === 1 &&
    r.kdf?.alg === 'PBKDF2-SHA256' &&
    Number.isInteger(r.kdf.iterations) &&
    r.kdf.iterations > 0 &&
    typeof r.kdf.salt === 'string' &&
    typeof r.iv === 'string' &&
    typeof r.check === 'string' &&
    B64.test(r.kdf.salt) &&
    B64.test(r.iv) &&
    B64.test(r.check)
  if (!ok) return null
  return fromBase64(r.kdf.salt).length === SALT_BYTES &&
    fromBase64(r.iv).length === 12 &&
    fromBase64(r.check).length > 0
    ? r
    : null
}

async function checkOf(password: string, salt: Uint8Array, iv: Uint8Array, iterations: number): Promise<Uint8Array> {
  const kek = await deriveKek(password, salt, iterations)
  // The derived key only wraps keys: wrap a fixed all-zero key, deterministic for a given salt and iv.
  const fixed = await crypto.subtle.importKey('raw', BLOCK, { name: 'AES-GCM' }, true, ['encrypt'])
  const out = await crypto.subtle.wrapKey('raw', fixed, kek, {
    name: 'AES-GCM',
    iv: new Uint8Array(iv),
    additionalData: AAD,
  })
  return new Uint8Array(out)
}

/** Compares in time independent of where the bytes differ. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function guardOf(store: LocalStore, rng: Rng, iterations = PBKDF2_ITERATIONS): Guard {
  const load = async () => parse(await store.read(['kv'], (tx) => tx.get<unknown>('kv', GUARD_KEY)))
  const write = async (password: string) => {
    if (password.length < GUARD_MIN_LENGTH) throw new RangeError(`Password shorter than ${GUARD_MIN_LENGTH}`)
    const salt = randomBytes(rng, SALT_BYTES)
    const iv = randomBytes(rng, 12)
    const check = await checkOf(password, salt, iv, iterations)
    const rec: GuardRecord = {
      v: 1,
      kdf: { alg: 'PBKDF2-SHA256', iterations, salt: toBase64(salt) },
      iv: toBase64(iv),
      check: toBase64(check),
    }
    await store.commit([{ put: 'kv', key: GUARD_KEY, value: rec }])
  }
  const verify = async (password: string) => {
    const rec = await load()
    if (!rec || password.length === 0) return false
    const got = await checkOf(password, fromBase64(rec.kdf.salt), fromBase64(rec.iv), rec.kdf.iterations)
    return equalBytes(got, fromBase64(rec.check))
  }
  return {
    isSet: async () => (await load()) !== null,
    async set(password) {
      if (await load()) throw new Error('A password is already set')
      await write(password)
    },
    verify,
    async change(current, next) {
      if (!(await verify(current))) return false
      await write(next)
      return true
    },
    async remove(current) {
      if (!(await verify(current))) return false
      await store.commit([{ delete: 'kv', key: GUARD_KEY }])
      return true
    },
  }
}
