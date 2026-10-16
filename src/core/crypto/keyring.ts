import type { Rng } from '../contracts/ports'
import type { Key } from '../contracts/remote'
import { sha256Hex } from '../log/codec'
import type { Secrets } from '../storage/secrets'
import type { DestKeyring } from '../sync/engine'
import { deriveKek, fromBase64, PBKDF2_ITERATIONS, randomBytes, SALT_BYTES, toBase64 } from './kdf'

/**
 * `keys/<sha256>.json`: the destination's data key (DEK) wrapped by a passphrase key (KEK).
 * Immutable and never deleted: a destination's key files are a union, one per (key, passphrase).
 * Changing the passphrase adds a file; the old passphrase keeps opening the old one.
 */
export interface KeyEnvelope {
  v: 1
  keyId: string
  kdf: { alg: 'PBKDF2-SHA256'; iterations: number; salt: string }
  wrap: { alg: 'AES-GCM'; iv: string; data: string }
}

export interface KeyFile {
  key: Key
  body: Uint8Array
}

/** Shortest passphrase the app accepts: it is all that stands between a backup and anyone who reads it. */
export const PASSPHRASE_MIN_LENGTH = 10

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })
const KEY_ID = /^[0-9a-f]{16}$/
const DEK_USAGES: KeyUsage[] = ['encrypt', 'decrypt']

const wrapAad = (keyId: string): Uint8Array<ArrayBuffer> => enc.encode(`cursus/1|key|${keyId}`)

export function keyFileKey(body: Uint8Array): Key {
  return `keys/${sha256Hex(body)}.json`
}

/** Strict parse; null for anything that is not a v1 envelope matching its file name. */
export function parseEnvelope(file: KeyFile): KeyEnvelope | null {
  if (keyFileKey(file.body) !== file.key) return null
  let x: unknown
  try {
    x = JSON.parse(dec.decode(file.body))
  } catch {
    return null // not JSON: not an envelope this build understands
  }
  const e = x as KeyEnvelope
  const ok =
    typeof x === 'object' &&
    x !== null &&
    e.v === 1 &&
    typeof e.keyId === 'string' &&
    KEY_ID.test(e.keyId) &&
    e.kdf?.alg === 'PBKDF2-SHA256' &&
    Number.isInteger(e.kdf.iterations) &&
    typeof e.kdf.salt === 'string' &&
    e.wrap?.alg === 'AES-GCM' &&
    typeof e.wrap.iv === 'string' &&
    typeof e.wrap.data === 'string'
  return ok ? e : null
}

async function wrap(dek: CryptoKey, keyId: string, passphrase: string, rng: Rng, iterations: number): Promise<KeyFile> {
  const salt = randomBytes(rng, SALT_BYTES)
  const iv = randomBytes(rng, 12)
  const kek = await deriveKek(passphrase, salt, iterations)
  const data = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv, additionalData: wrapAad(keyId) })
  const env: KeyEnvelope = {
    v: 1,
    keyId,
    kdf: { alg: 'PBKDF2-SHA256', iterations, salt: toBase64(salt) },
    wrap: { alg: 'AES-GCM', iv: toBase64(iv), data: toBase64(new Uint8Array(data)) },
  }
  const body = enc.encode(JSON.stringify(env))
  return { key: keyFileKey(body), body }
}

/** Unwraps a DEK; null on a wrong passphrase (the AES-GCM tag does not verify). */
async function unwrap(env: KeyEnvelope, passphrase: string, extractable: boolean): Promise<CryptoKey | null> {
  const kek = await deriveKek(passphrase, fromBase64(env.kdf.salt), env.kdf.iterations)
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      fromBase64(env.wrap.data),
      kek,
      { name: 'AES-GCM', iv: fromBase64(env.wrap.iv), additionalData: wrapAad(env.keyId) },
      { name: 'AES-GCM', length: 256 },
      extractable,
      DEK_USAGES,
    )
  } catch (e) {
    if (e instanceof DOMException && e.name === 'OperationError') return null // wrong passphrase
    throw e
  }
}

export interface KeyringOptions {
  secrets: Secrets
  destId: string
  rng: Rng
  /** 600 000 in the app, 1 000 in tests. */
  iterations?: number
}

export interface DestinationKeyring extends DestKeyring {
  learn(files: KeyFile[]): Promise<void>
  /** A new data key for a destination being sealed; returns the key file to write there FIRST. */
  create(passphrase: string): Promise<KeyFile & { keyId: string }>
  /** Unlocks every known key file this passphrase opens; returns how many keys became available. */
  unlock(passphrase: string): Promise<number>
  /** New key file for the same data key under a new passphrase (needs the current one). */
  changePassphrase(current: string, next: string): Promise<KeyFile>
  /** Key files known for this destination. */
  files(): Promise<KeyFile[]>
  keyIdOf(file: KeyFile): string | null
  /** Forgets the unlocked keys on this device (the key files stay on the destination). */
  lock(): Promise<void>
}

/**
 * Per-destination keyring. Unlocked DEKs are stored as NON-extractable CryptoKeys in the device-only
 * `secrets` store, so a session restart does not ask the passphrase again and the raw key never
 * leaves WebCrypto. New uploads use the smallest unlocked keyId, so every device converges on one key.
 */
export function createKeyring(o: KeyringOptions): DestinationKeyring {
  const iterations = o.iterations ?? PBKDF2_ITERATIONS
  const dekName = (keyId: string): string => `dek:${o.destId}:${keyId}`
  const filesName = `keyfiles:${o.destId}`

  const knownFiles = async (): Promise<KeyFile[]> => (await o.secrets.get<KeyFile[]>(filesName)) ?? []
  const remember = async (files: KeyFile[]): Promise<void> => {
    const known = await knownFiles()
    const keys = new Set(known.map((f) => f.key))
    const fresh = files.filter((f) => !keys.has(f.key) && parseEnvelope(f) !== null)
    if (fresh.length > 0) await o.secrets.set(filesName, [...known, ...fresh])
  }
  const unlockedIds = async (): Promise<string[]> => {
    const prefix = `dek:${o.destId}:`
    return (await o.secrets.names())
      .filter((n) => n.startsWith(prefix))
      .map((n) => n.slice(prefix.length))
      .sort()
  }

  const ring: DestinationKeyring = {
    async current() {
      for (const id of await unlockedIds()) {
        const key = await o.secrets.get<CryptoKey>(dekName(id))
        if (key) return { id, key }
      }
      return null
    },
    async byId(id) {
      return (await o.secrets.get<CryptoKey>(dekName(id))) ?? null
    },
    learn: remember,
    async files() {
      return knownFiles()
    },
    keyIdOf(file) {
      return parseEnvelope(file)?.keyId ?? null
    },
    async create(passphrase) {
      const keyId = Array.from(randomBytes(o.rng, 8), (b) => b.toString(16).padStart(2, '0')).join('')
      const raw = randomBytes(o.rng, 32)
      const extractable = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, DEK_USAGES)
      raw.fill(0)
      const file = await wrap(extractable, keyId, passphrase, o.rng, iterations)
      const stored = await unwrap(parseEnvelope(file) as KeyEnvelope, passphrase, false)
      if (!stored) throw new Error('Freshly wrapped key does not unwrap')
      await o.secrets.set(dekName(keyId), stored)
      await remember([file])
      return { ...file, keyId }
    },
    async unlock(passphrase) {
      let n = 0
      for (const f of await knownFiles()) {
        const env = parseEnvelope(f)
        if (!env || (await ring.byId(env.keyId))) continue
        const dek = await unwrap(env, passphrase, false)
        if (!dek) continue
        await o.secrets.set(dekName(env.keyId), dek)
        n++
      }
      return n
    },
    async changePassphrase(current, next) {
      for (const f of await knownFiles()) {
        const env = parseEnvelope(f)
        if (!env) continue
        const dek = await unwrap(env, current, true)
        if (!dek) continue
        const file = await wrap(dek, env.keyId, next, o.rng, iterations)
        await remember([file])
        return file
      }
      throw new RangeError('The current passphrase opens none of the key files')
    },
    async lock() {
      for (const id of await unlockedIds()) await o.secrets.delete(dekName(id))
    },
  }
  return ring
}
