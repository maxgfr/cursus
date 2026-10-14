import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { blobKey, bmanKey, sha256Hex } from '../log/codec'
import { canonicalJson, canonicalState, diffCanonical, FMT_V1, hashMatches, verifyPass } from './verify'

describe('hashMatches', () => {
  test('content-addressed keys check their hash; markers their content', () => {
    const body = new Uint8Array([1, 2, 3])
    const h = sha256Hex(body)
    expect(hashMatches(`seg/d/0000000000-${h.slice(0, 16)}.seg`, body)).toBe(true)
    expect(hashMatches(`ckpt/d/${h.slice(0, 16)}.ckpt`, body)).toBe(true)
    expect(hashMatches(blobKey(h), body)).toBe(true)
    expect(hashMatches(bmanKey(h), new Uint8Array([9]))).toBe(false)
    expect(hashMatches(`keys/${h}.json`, body)).toBe(true)
    expect(hashMatches('fmt/v1', FMT_V1)).toBe(true)
    expect(hashMatches('fmt/v1', body)).toBe(false)
    expect(hashMatches('ws/01X', body)).toBe(true)
    expect(hashMatches('mirror/x', body)).toBe(false)
  })
})

describe('canonical state', () => {
  test('same content ⇒ same JSON whatever the insertion order; empty roots ignored', () => {
    const a = new Y.Doc()
    a.getMap('courses').set('x', 1)
    a.getMap('courses').set('y', { b: 1, a: [1, new Uint8Array([7])] })
    a.getArray('reviews').push([{ id: 'r' }])
    const b = new Y.Doc()
    Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a))
    b.getMap('prefs')
    expect(canonicalJson(b)).toBe(canonicalJson(a))
    expect(Object.keys(canonicalState(a))).toEqual(['courses', 'reviews'])
  })

  test('unknown roots are described by their type', () => {
    const a = new Y.Doc()
    a.getText('t').insert(0, 'hi')
    a.getArray('list').push([1])
    a.getMap('m').set('k', 'v')
    const b = new Y.Doc()
    Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a))
    expect(canonicalState(a)).toEqual({ list: [1], m: { k: 'v' }, t: 'hi' })
    expect(canonicalState(b)).toMatchObject({ list: [1], m: { k: 'v' } })
  })

  test('diff lists differing paths, bounded', () => {
    expect(diffCanonical({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([])
    expect(diffCanonical({ a: { b: 1, c: 2 } }, { a: { b: 3 } })).toEqual([
      'a.b: local=1 restored=3',
      'a.c: local=2 restored=missing',
    ])
    expect(diffCanonical({ x: 1, y: 2 }, {}, 1).length).toBe(1)
  })
})

describe('verifyPass', () => {
  test('resumes after the cursor and clears it at the end', async () => {
    const checked: string[] = []
    const cursors: (string | undefined)[] = []
    const progress: number[] = []
    const r = await verifyPass({
      keys: ['a', 'b', 'c', 'd'],
      cursor: 'b',
      check: async (k) => {
        checked.push(k)
        return k === 'c' ? 'repaired' : k === 'd' ? 'corrupt' : 'ok'
      },
      saveCursor: async (k) => {
        cursors.push(k)
      },
      onProgress: (d) => progress.push(d),
    })
    expect(checked).toEqual(['c', 'd'])
    expect(r).toEqual({ corrupt: 2, repaired: 1 })
    expect(cursors).toEqual(['c', 'd', undefined])
    expect(progress).toEqual([2, 3, 4])
  })
})
