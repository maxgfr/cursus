import { EnvelopeError } from '../contracts/errors'
import type { Keyring, Sealer } from '../contracts/log'
import type { Rng } from '../contracts/ports'
import type { Entry, Key, RemoteStore } from '../contracts/remote'
import { parseManifest } from '../log/blobs'
import { blobKey, bmanKey, codec, parseKey } from '../log/codec'
import { KeyUnavailableError, ObjectIntegrityError } from '../sync/engine'
import { runListing } from '../sync/listing'
import { FMT_KEY, FMT_V1, hashMatches } from '../sync/verify'
import { randomBytes } from './kdf'
import type { KeyFile } from './keyring'

/** Sealed object: "CRSE" | keyId length (1) | keyId | iv (12) | AES-GCM(plain, AAD = "cursus/1|" + key). */
export const CRSE = new Uint8Array([0x43, 0x52, 0x53, 0x45])
const IV_BYTES = 12
const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

export type SealErrorKind = 'format' | 'auth'
/** format: not a sealed object; auth: tampered, or moved to another key (the AAD binds the key name). */
export class SealError extends ObjectIntegrityError {
  constructor(
    readonly kind: SealErrorKind,
    m: string,
  ) {
    super(m)
    this.name = 'SealError'
  }
}

const aad = (key: Key): Uint8Array<ArrayBuffer> => enc.encode(`cursus/1|${key}`)

export function isSealed(body: Uint8Array): boolean {
  return body.length > CRSE.length && CRSE.every((b, i) => body[i] === b)
}

function parse(body: Uint8Array): { keyId: string; iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> } {
  if (!isSealed(body)) throw new SealError('format', 'Not a sealed object')
  const n = body[CRSE.length] ?? 0
  const start = CRSE.length + 1
  if (n === 0 || body.length < start + n + IV_BYTES) throw new SealError('format', 'Truncated sealed object')
  let keyId: string
  try {
    keyId = dec.decode(body.subarray(start, start + n))
  } catch (e) {
    throw new SealError('format', `Bad key id: ${String(e)}`)
  }
  return {
    keyId,
    iv: body.slice(start + n, start + n + IV_BYTES),
    ct: body.slice(start + n + IV_BYTES),
  }
}

/** Seals with the keyring's current key (the smallest unlocked keyId); IVs come from the injected Rng. */
export function createSealer(rng: Rng): Sealer {
  return {
    async seal(k: Keyring, key: Key, plain: Uint8Array): Promise<Uint8Array> {
      const cur = await k.current()
      if (!cur) throw new KeyUnavailableError('none')
      const id = enc.encode(cur.id)
      if (id.length === 0 || id.length > 255) throw new RangeError(`Invalid key id ${cur.id}`)
      const iv = randomBytes(rng, IV_BYTES)
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(key) }, cur.key, new Uint8Array(plain)),
      )
      const out = new Uint8Array(CRSE.length + 1 + id.length + IV_BYTES + ct.length)
      out.set(CRSE, 0)
      out[CRSE.length] = id.length
      out.set(id, CRSE.length + 1)
      out.set(iv, CRSE.length + 1 + id.length)
      out.set(ct, CRSE.length + 1 + id.length + IV_BYTES)
      return out
    },
    async open(k: Keyring, key: Key, body: Uint8Array): Promise<Uint8Array> {
      const { keyId, iv, ct } = parse(body)
      const dek = await k.byId(keyId)
      if (!dek) throw new KeyUnavailableError(keyId)
      try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(key) }, dek, ct))
      } catch (e) {
        if (e instanceof DOMException && e.name === 'OperationError') {
          throw new SealError('auth', `Sealed object ${key} does not authenticate`)
        }
        throw e
      }
    },
  }
}

export interface SealReport {
  copied: number
  /** Objects of the old root that could not be read intact (left out of the copy). */
  unreadable: Key[]
  /** Objects left out because a file they need was left out (closure is never broken). */
  deferred: Key[]
  /** After the copy, read back from the new root: missing or not opening to the right content. */
  missing: Key[]
  corrupt: Key[]
  ok: boolean
}

/**
 * Seals an existing destination: a NEW prefix (a new destination id) receives the key file first, then
 * a sealed copy of every object, then is verified by reading everything back. The old plaintext root is
 * left untouched; only `removePlaintextRoot`, on an explicit user action, deletes it.
 * With no source, this initialises an empty sealed destination.
 */
export async function sealDestination(o: {
  source?: RemoteStore
  target: RemoteStore
  keyring: Keyring
  sealer: Sealer
  keyFile: KeyFile
  pageSize?: number
}): Promise<SealReport> {
  await o.target.put(o.keyFile.key, o.keyFile.body)
  const report: SealReport = { copied: 0, unreadable: [], deferred: [], missing: [], corrupt: [], ok: true }
  // The key file must be visible BEFORE any object: it is what tells every device "sealed".
  const keys = await runListing(o.target, { full: false, calls: [{ prefix: 'keys/' }] }, { pageSize: o.pageSize })
  if (!keys.entries.has(o.keyFile.key)) return { ...report, missing: [o.keyFile.key], ok: false }
  // fmt/v1 right after the key file: a sealed root always shows it, so a device that was not told the
  // destination is sealed and whose listing lost keys/ treats it as unknown — never as a fresh,
  // plaintext destination.
  await o.target.put(FMT_KEY, FMT_V1)
  if (!o.source) return report
  const listing = await runListing(o.source, { full: true, calls: [{ prefix: '' }] }, { pageSize: o.pageSize })
  const copied: Key[] = []
  const done = new Set<Key>()
  // Same order as the engine: chunks → manifests → segments, each only once what it needs is copied.
  const rank = (k: Key): number => ['fmt', 'ws', 'blob', 'bman'].indexOf(parseKey(k)?.kind ?? '') + 1 || 5
  const ordered = [...listing.entries].sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : 1))
  for (const [key, entries] of ordered) {
    const kind = parseKey(key)?.kind
    if (kind === 'keys') continue
    const plain = await firstIntact(o.source, key, entries)
    if (!plain) {
      report.unreadable.push(key)
      continue
    }
    const needs = needsCopied(key, plain)
    if (needs === null) {
      report.unreadable.push(key)
      continue
    }
    if (!needs.every((k) => done.has(k))) {
      report.deferred.push(key)
      continue
    }
    // fmt/v1 stays readable; the ws/ marker is sealed too (an empty, plaintext marker proves plaintext).
    const sealed = kind === 'fmt' ? plain : await o.sealer.seal(o.keyring, key, plain)
    await o.target.put(key, sealed)
    copied.push(key)
    done.add(key)
  }
  report.copied = copied.length
  const after = await runListing(o.target, { full: true, calls: [{ prefix: '' }] }, { pageSize: o.pageSize })
  for (const key of copied) {
    const entries = after.entries.get(key)
    if (!entries) {
      report.missing.push(key)
      continue
    }
    const kind = parseKey(key)?.kind
    let intact = false
    for (const e of entries) {
      const body = await o.target.get(e)
      if (!body) continue
      if (kind === 'fmt' || kind === 'ws') intact = hashMatches(key, body)
      else {
        try {
          intact = hashMatches(key, await o.sealer.open(o.keyring, key, body))
        } catch (err) {
          // Damaged, or not sealed with our key: not our copy. Another duplicate may be fine.
          if (!(err instanceof SealError || err instanceof KeyUnavailableError)) throw err
          intact = false
        }
      }
      if (intact) break
    }
    if (!intact) report.corrupt.push(key)
  }
  report.ok =
    report.unreadable.length === 0 &&
    report.deferred.length === 0 &&
    report.missing.length === 0 &&
    report.corrupt.length === 0
  return report
}

/** Keys an object needs on the same destination (a manifest its chunks, a segment its files); null: unreadable. */
function needsCopied(key: Key, plain: Uint8Array): Key[] | null {
  const kind = parseKey(key)?.kind
  try {
    if (kind === 'bman') return parseManifest(plain).chunks.map(blobKey)
    if (kind === 'seg' || kind === 'ckpt') return codec.decode(key, plain).header.blobRefs.map(bmanKey)
    return []
  } catch (e) {
    if (!(e instanceof EnvelopeError)) throw e
    return e.kind === 'version' ? [] : null // too new to read: copied as is; garbage: left out
  }
}

async function firstIntact(remote: RemoteStore, key: Key, entries: Entry[]): Promise<Uint8Array | null> {
  for (const e of entries) {
    const body = await remote.get(e)
    if (body && hashMatches(key, body)) return body
  }
  return null
}

/**
 * Deletes the old plaintext root after sealing — ONLY on an explicit user action, and only once a
 * complete, verified sealed copy exists.
 */
export async function removePlaintextRoot(
  old: RemoteStore & { delete(key: Key): Promise<void> },
  o: { userConfirmed: true; sealedCopy: SealReport },
): Promise<number> {
  if (o.userConfirmed !== true) throw new Error('Removing the plaintext root needs an explicit confirmation')
  if (!o.sealedCopy.ok) throw new Error('The sealed copy is incomplete: the plaintext root is kept')
  const keys = new Set<Key>()
  for await (const e of old.list('')) keys.add(e.key)
  for (const k of keys) await old.delete(k)
  return keys.size
}
