import type { Rng } from '../contracts/ports'

/** OWASP 2023 figure for PBKDF2-HMAC-SHA256. Tests inject 1 000. */
export const PBKDF2_ITERATIONS = 600_000
export const SALT_BYTES = 16

const enc = new TextEncoder()

/** Random bytes from the injected Rng (crypto in the app, seeded in tests). */
export function randomBytes(rng: Rng, n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n))
  for (let i = 0; i < n; i += 4) {
    const x = rng.u32()
    for (let j = 0; j < 4 && i + j < n; j++) out[i + j] = (x >>> (8 * j)) & 0xff
  }
  return out
}

/**
 * Key-encryption key from a passphrase: PBKDF2-SHA256 → AES-GCM 256, usable only to wrap and unwrap
 * data keys, never extractable. The passphrase is NFC-normalised so the same words typed on iPad and
 * Mac give the same key.
 */
export async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  if (passphrase.length === 0) throw new RangeError('Empty passphrase')
  if (!Number.isInteger(iterations) || iterations < 1) throw new RangeError(`Invalid iterations ${iterations}`)
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
