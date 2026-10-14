import * as Y from 'yjs'
import type { Key } from '../contracts/remote'
import { parseKey, sha256Hex } from '../log/codec'
import { ROOT } from '../model/schema'

/** Fixed content of `fmt/v1`. */
export const FMT_KEY = 'fmt/v1'
export const FMT_V1 = new TextEncoder().encode('cursus/1\n')

/** Does `plain` match its content-addressed key? (`ws/` markers carry no content to check.) */
export function hashMatches(key: Key, plain: Uint8Array): boolean {
  const p = parseKey(key)
  if (!p) return false
  switch (p.kind) {
    case 'seg':
    case 'ckpt':
      return sha256Hex(plain).slice(0, 16) === p.h16
    case 'blob':
    case 'bman':
      return sha256Hex(plain) === p.h64
    case 'keys':
      return sha256Hex(plain) === p.hash
    case 'fmt':
      return plain.length === FMT_V1.length && plain.every((b, i) => b === FMT_V1[i])
    case 'ws':
      return true
  }
}

const ARRAY_ROOTS: ReadonlySet<string> = new Set([ROOT.reviews, ROOT.aiUsage])
const MAP_ROOTS: readonly string[] = [ROOT.courses, ROOT.sources, ROOT.fiches, ROOT.cards, ROOT.texts, ROOT.prefs]

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v instanceof Uint8Array) return [...v]
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

function isEmpty(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0
  return v !== null && typeof v === 'object' && Object.keys(v).length === 0
}

/**
 * Canonical content of a doc: every root by name, keys sorted, empty roots dropped (an absent root and
 * an empty one hold the same data). Only call it on a doc built for comparison: it instantiates roots.
 */
export function canonicalState(doc: Y.Doc): Record<string, unknown> {
  const names = new Set<string>([...MAP_ROOTS, ...ARRAY_ROOTS, ...doc.share.keys()])
  const out: Record<string, unknown> = {}
  for (const name of [...names].sort()) {
    let v: unknown
    if (ARRAY_ROOTS.has(name)) v = doc.getArray(name).toJSON()
    else if (MAP_ROOTS.includes(name)) v = doc.getMap(name).toJSON()
    else {
      const t = doc.share.get(name)
      if (t instanceof Y.Text) v = t.toString()
      else if (t instanceof Y.Array) v = t.toJSON()
      else if (t instanceof Y.Map) v = t.toJSON()
      else v = t && t._map.size > 0 ? doc.getMap(name).toJSON() : doc.getArray(name).toJSON()
    }
    if (!isEmpty(v)) out[name] = sortKeys(v)
  }
  return out
}

export const canonicalJson = (doc: Y.Doc): string => JSON.stringify(canonicalState(doc))

function flatten(v: unknown, path: string, out: Map<string, string>): void {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
    for (const [k, x] of Object.entries(v)) flatten(x, path ? `${path}.${k}` : k, out)
  } else out.set(path, JSON.stringify(v))
}

/** Paths whose values differ, as `path: local=… restored=…` (at most `limit` lines). */
export function diffCanonical(local: unknown, restored: unknown, limit = 100): string[] {
  const a = new Map<string, string>()
  const b = new Map<string, string>()
  flatten(local, '', a)
  flatten(restored, '', b)
  const out: string[] = []
  for (const p of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(p)
    const y = b.get(p)
    if (x !== y) out.push(`${p}: local=${x ?? 'missing'} restored=${y ?? 'missing'}`)
    if (out.length >= limit) break
  }
  return out
}

export type CheckResult = 'ok' | 'repaired' | 'corrupt'

/**
 * Integrity pass over a sorted key list, resumable: it starts after `cursor` and saves the cursor after
 * each key, so an interrupted "Verify" picks up where it stopped. The cursor is cleared at the end.
 */
export async function verifyPass(o: {
  keys: readonly Key[]
  cursor?: Key
  check: (key: Key) => Promise<CheckResult>
  saveCursor: (key: Key | undefined) => Promise<void>
  onProgress?: (done: number, total: number) => void
}): Promise<{ corrupt: number; repaired: number }> {
  const total = o.keys.length
  let done = o.cursor === undefined ? 0 : o.keys.filter((k) => k <= (o.cursor ?? '')).length
  let corrupt = 0
  let repaired = 0
  o.onProgress?.(done, total)
  for (const key of o.keys) {
    if (o.cursor !== undefined && key <= o.cursor) continue
    const r = await o.check(key)
    if (r !== 'ok') corrupt++
    if (r === 'repaired') repaired++
    await o.saveCursor(key)
    o.onProgress?.(++done, total)
  }
  await o.saveCursor(undefined)
  return { corrupt, repaired }
}
