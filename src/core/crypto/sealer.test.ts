import { describe, expect, test } from 'bun:test'
import type { Key } from '../contracts/remote'
import { parseKey } from '../log/codec'
import { seededRng } from '../ports/rng'
import { memoryStore } from '../storage/memoryStore'
import { secretsVault } from '../storage/secrets'
import { KeyUnavailableError } from '../sync/engine'
import { all, device, world } from '../sync/harness.test'
import { faultyRemote } from '../sync/providers/faulty'
import { memoryRemote } from '../sync/providers/memory'
import { createKeyring } from './keyring'
import { CRSE, createSealer, isSealed, removePlaintextRoot, SealError, sealDestination } from './sealer'

const ITER = 1000

function keyring(seed: number, destId: string) {
  return createKeyring({ secrets: secretsVault(memoryStore()), destId, rng: seededRng(seed), iterations: ITER })
}

/** Every object of a root, except the markers, must be sealed. */
function assertAllSealed(w: ReturnType<typeof world>, prefix: string): number {
  let n = 0
  for (const full of w.bucket.keys(`${prefix}/`)) {
    const key = full.slice(prefix.length + 1)
    const kind = parseKey(key)?.kind
    if (kind === 'fmt' || kind === 'ws' || kind === 'keys') continue
    expect(isSealed(w.bucket.read(full) as Uint8Array)).toBe(true)
    n++
  }
  return n
}

describe('sealer', () => {
  test('round-trip with CRSE header; IVs never repeat', async () => {
    const r = keyring(1, 'd')
    const { keyId } = await r.create('p')
    const s = createSealer(seededRng(7))
    const plain = new TextEncoder().encode('secret notes')
    const a = await s.seal(r, 'seg/x/0000000000-0123456789abcdef.seg', plain)
    const b = await s.seal(r, 'seg/x/0000000000-0123456789abcdef.seg', plain)
    expect([...a.slice(0, 4)]).toEqual([...CRSE])
    expect(new TextDecoder().decode(a.slice(5, 5 + keyId.length))).toBe(keyId)
    expect(a).not.toEqual(b)
    expect(await s.open(r, 'seg/x/0000000000-0123456789abcdef.seg', a)).toEqual(plain)
    expect(isSealed(plain)).toBe(false)
  })

  test('wrong passphrase: the key never unlocks, nothing opens', async () => {
    const a = keyring(1, 'd')
    const f = await a.create('right')
    const s = createSealer(seededRng(1))
    const body = await s.seal(a, 'blob/ab/x', new Uint8Array([1]))
    const b = keyring(2, 'd')
    await b.learn([f])
    expect(await b.unlock('wrong')).toBe(0)
    await expect(s.open(b, 'blob/ab/x', body)).rejects.toBeInstanceOf(KeyUnavailableError)
    await expect(s.seal(b, 'blob/ab/x', new Uint8Array([1]))).rejects.toBeInstanceOf(KeyUnavailableError)
  })

  test('swapped or tampered objects fail authentication (the AAD binds the key name)', async () => {
    const r = keyring(1, 'd')
    await r.create('p')
    const s = createSealer(seededRng(3))
    const one = await s.seal(r, 'seg/a/0000000000-0000000000000001.seg', new Uint8Array([1, 1]))
    const two = await s.seal(r, 'seg/a/0000000001-0000000000000002.seg', new Uint8Array([2, 2]))
    await expect(s.open(r, 'seg/a/0000000001-0000000000000002.seg', one)).rejects.toMatchObject({ kind: 'auth' })
    await expect(s.open(r, 'seg/a/0000000000-0000000000000001.seg', two)).rejects.toBeInstanceOf(SealError)
    const tampered = one.slice()
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
    await expect(s.open(r, 'seg/a/0000000000-0000000000000001.seg', tampered)).rejects.toMatchObject({ kind: 'auth' })
    await expect(s.open(r, 'k', new Uint8Array([1, 2, 3, 4, 5]))).rejects.toMatchObject({ kind: 'format' })
    await expect(s.open(r, 'k', new Uint8Array([...CRSE, 0, 1]))).rejects.toMatchObject({ kind: 'format' })
    await expect(s.open(r, 'k', new Uint8Array([...CRSE, 2, 0xff, 0xfe, ...new Uint8Array(20)]))).rejects.toMatchObject(
      {
        kind: 'format',
      },
    )
    await expect(s.open(r, 'k', new Uint8Array([...CRSE, 1, 0x41, ...new Uint8Array(20)]))).rejects.toBeInstanceOf(
      KeyUnavailableError,
    )
  })

  test('key ids must fit the header', async () => {
    const s = createSealer(seededRng(1))
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const long = { current: async () => ({ id: 'x'.repeat(300), key }), byId: async () => key }
    await expect(s.seal(long, 'k', new Uint8Array())).rejects.toThrow(RangeError)
  })
})

describe('sealed destinations end to end', () => {
  async function sealedSetup() {
    const w = world()
    const target = w.remote('sealed')
    const ringA = keyring(11, target.id)
    const keyFile = await ringA.create('hunter2 hunter2')
    const sealer = createSealer(seededRng(12))
    await sealDestination({ target, keyring: ringA, sealer, keyFile })
    return { w, target, ringA, keyFile, sealer }
  }

  test('relay: a device on a sealed and a plain destination carries data both ways, sealed only where due', async () => {
    const { w, target, ringA, keyFile, sealer } = await sealedSetup()
    const a = await device(1, w.clock, { sealer })
    const sealedId = a.engine.addDest({ remote: target, keyring: ringA, sealed: true })
    const blob = await a.attach(new Uint8Array([7, 7, 7]))
    a.ws.courses.create({ title: 'from sealed side' })
    await a.commit()
    await a.engine.round(sealedId)
    expect(assertAllSealed(w, 'sealed')).toBeGreaterThan(2)

    const ringC = keyring(13, target.id)
    const c = await device(3, w.clock, { sealer: createSealer(seededRng(14)) })
    c.engine.addDest({ remote: w.remote('sealed'), keyring: ringC })
    const plainId = c.engine.addDest({ remote: w.remote('plain') })
    await c.engine.round(sealedId)
    expect(c.engine.status().dests[0]?.state).toBe('needs-passphrase')
    expect((await ringC.files()).map((f) => f.key)).toEqual([keyFile.key])
    expect(await ringC.unlock('hunter2 hunter2')).toBe(1)
    await c.engine.round(sealedId)
    await c.engine.round(plainId)
    expect(c.ws.courses.list().map((x) => x.title)).toEqual(['files', 'from sealed side'])
    expect(await c.blobs.get(blob)).not.toBeNull()
    // the plain side holds plaintext, readable without any key
    for (const full of w.bucket.keys('plain/')) expect(isSealed(w.bucket.read(full) as Uint8Array)).toBe(false)

    const b = await device(2, w.clock, { confirmWorkspace: async () => true })
    b.engine.addDest({ remote: w.remote('plain') })
    await b.engine.round(plainId)
    b.ws.courses.create({ title: 'from plain side' })
    await b.commit()
    await b.engine.round(plainId)
    await c.engine.round(plainId)
    await c.engine.round(sealedId)
    await a.engine.round(sealedId)
    expect(new Set(a.ws.courses.list().map((x) => x.title))).toEqual(
      new Set(['files', 'from sealed side', 'from plain side']),
    )
    assertAllSealed(w, 'sealed')
    expect(await a.engine.restoreDrill(sealedId)).toEqual({ equal: true, diff: [] })
    expect((await a.engine.verify(sealedId)).corrupt).toBe(0)
  })

  test('a device that stayed offline never sends plaintext to a sealed destination', async () => {
    const { w, target, keyFile, sealer } = await sealedSetup()
    // configured with that destination but without the passphrase (no keyring, no sealer, no hint)
    const d = await device(4, w.clock)
    const id = d.engine.addDest({ remote: target })
    d.ws.courses.create({ title: 'offline edits' })
    await d.commit()
    const before = w.bucket.keys('sealed/')
    await d.engine.round(id)
    await d.engine.round(id)
    expect(d.engine.status().dests[0]?.state).toBe('needs-passphrase')
    expect(w.bucket.keys('sealed/')).toEqual(before)
    // with a locked keyring and a sealer: still nothing; once unlocked: sealed only
    const ring = keyring(15, target.id)
    const e = await device(5, w.clock, { sealer, confirmWorkspace: async () => true })
    const eid = e.engine.addDest({ remote: w.remote('sealed'), keyring: ring })
    e.ws.courses.create({ title: 'more offline edits' })
    await e.commit()
    await e.engine.round(eid)
    expect(w.bucket.keys('sealed/')).toEqual(before)
    await ring.learn([keyFile])
    await ring.unlock('hunter2 hunter2')
    await e.engine.round(eid)
    expect(w.bucket.keys('sealed/').length).toBeGreaterThan(before.length)
    assertAllSealed(w, 'sealed')
  })

  test('sealing an existing destination: new prefix, copy, verify; old plaintext kept until the user removes it', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const oldRemote = memoryRemote({ bucket: w.bucket, prefix: 'cursus' })
    const oldId = a.engine.addDest({ remote: oldRemote })
    await a.attach(new Uint8Array(64).fill(1))
    a.ws.courses.create({ title: 'Bio' })
    await a.commit()
    await a.engine.round(oldId)
    const oldKeys = w.bucket.keys('cursus/')
    const newRemote = memoryRemote({ bucket: w.bucket, prefix: 'cursus-sealed' })
    expect(newRemote.id).not.toBe(oldRemote.id)
    const ring = keyring(21, newRemote.id)
    const sealer = createSealer(seededRng(22))
    const keyFile = await ring.create('pass')
    const report = await sealDestination({ source: oldRemote, target: newRemote, keyring: ring, sealer, keyFile })
    expect(report).toMatchObject({ ok: true, unreadable: [], missing: [], corrupt: [] })
    expect(report.copied).toBe(oldKeys.length)
    assertAllSealed(w, 'cursus-sealed')
    expect(w.bucket.keys('cursus/')).toEqual(oldKeys)
    // the sealed copy is a complete destination: a new device restores from it alone
    const fresh = await device(6, w.clock, { sealer })
    const ringF = keyring(23, newRemote.id)
    const fid = fresh.engine.addDest({ remote: newRemote, keyring: ringF })
    await fresh.engine.round(fid)
    await ringF.unlock('pass')
    await fresh.engine.round(fid)
    expect(fresh.ws.courses.list().map((c) => c.title)).toEqual(['files', 'Bio'])
    // explicit removal only, and only after a verified copy
    await expect(
      removePlaintextRoot(oldRemote, { userConfirmed: true, sealedCopy: { ...report, ok: false } }),
    ).rejects.toThrow()
    await expect(removePlaintextRoot(oldRemote, { userConfirmed: false as true, sealedCopy: report })).rejects.toThrow()
    expect(w.bucket.keys('cursus/')).toEqual(oldKeys)
    expect(await removePlaintextRoot(oldRemote, { userConfirmed: true, sealedCopy: report })).toBe(oldKeys.length)
    expect(w.bucket.keys('cursus/')).toEqual([])
  })

  test('a sealed root shows fmt/v1 right after its key file, and its ws/ marker is sealed', async () => {
    const w = world()
    const empty = memoryRemote({ bucket: w.bucket, prefix: 'empty' })
    const ring = keyring(41, empty.id)
    await sealDestination({
      target: empty,
      keyring: ring,
      sealer: createSealer(seededRng(3)),
      keyFile: await ring.create('p'),
    })
    expect(w.bucket.keys('empty/').map((k) => parseKey(k.slice(6))?.kind)).toEqual(['fmt', 'keys'])
    const src = memoryRemote({ bucket: w.bucket, prefix: 'plainsrc' })
    await src.put('ws/01W', new Uint8Array())
    const dst = memoryRemote({ bucket: w.bucket, prefix: 'sealeddst' })
    const ring2 = keyring(42, dst.id)
    const r = await sealDestination({
      source: src,
      target: dst,
      keyring: ring2,
      sealer: createSealer(seededRng(4)),
      keyFile: await ring2.create('p'),
    })
    expect(r.ok).toBe(true)
    expect(isSealed(w.bucket.read('sealeddst/ws/01W') as Uint8Array)).toBe(true)
  })

  test('sealing reports what it could not copy or verify', async () => {
    const w = world()
    const { sha256Hex } = await import('../log/codec')
    const src = memoryRemote({ bucket: w.bucket, prefix: 'src' })
    const good = new Uint8Array([1])
    const goodKey: Key = `bman/${sha256Hex(good)}`
    await src.put(goodKey, good)
    await src.put(`bman/${'0'.repeat(64)}`, new Uint8Array([2]))
    await src.put('ws/01X', new Uint8Array())
    await src.put(`keys/${'1'.repeat(64)}.json`, new Uint8Array([3]))
    // the key file does not show up: nothing is copied at all
    const target = faultyRemote(memoryRemote({ bucket: w.bucket, prefix: 'dst' }))
    const ring = keyring(31, target.id)
    const keyFile = await ring.create('p')
    target.inject('put-lost', 1)
    const r0 = await sealDestination({
      source: src,
      target,
      keyring: ring,
      sealer: createSealer(seededRng(1)),
      keyFile,
    })
    expect(r0).toMatchObject({ copied: 0, missing: [keyFile.key], ok: false })
    expect(w.bucket.keys('dst/')).toEqual([])
    // unreadable source object, an object lost on the way, an object stored damaged (both copies)
    const target2 = memoryRemote({ bucket: w.bucket, prefix: 'dst2' })
    const r1 = await sealDestination({
      source: src,
      target: {
        id: target2.id,
        list: (p, o) => target2.list(p, o),
        get: (e) => target2.get(e),
        put: async (k, b) => {
          if (k === 'ws/01X') return
          if (k === goodKey) {
            await target2.put(k, new Uint8Array([...CRSE, 1, 0x41, ...new Uint8Array(30)]))
            w.bucket.duplicate(`dst2/${k}`, new Uint8Array([8]))
            return
          }
          await target2.put(k, b)
        },
      },
      keyring: ring,
      sealer: createSealer(seededRng(2)),
      keyFile,
    })
    expect(r1.unreadable).toEqual([`bman/${'0'.repeat(64)}`])
    expect(r1.missing).toEqual(['ws/01X'])
    expect(r1.corrupt).toEqual([goodKey])
    expect(r1.ok).toBe(false)
    expect((await all(target2.list('keys/'))).map((e) => e.key)).toEqual([keyFile.key])
  })

  test('closure is kept: a file whose chunk cannot be read stays out, and so does its segment', async () => {
    const w = world()
    const a = await device(1, w.clock)
    const old = memoryRemote({ bucket: w.bucket, prefix: 'old' })
    const id = a.engine.addDest({ remote: old })
    const blob = await a.attach(new Uint8Array([5, 6, 7]))
    a.ws.courses.create({ title: 'x' })
    await a.commit()
    await a.engine.round(id)
    const chunk = (await a.blobs.objectKeys(blob))[0] as Key
    w.bucket.corrupt(`old/${chunk}`)
    const target = memoryRemote({ bucket: w.bucket, prefix: 'new' })
    const ring = keyring(41, target.id)
    const keyFile = await ring.create('p')
    const r = await sealDestination({ source: old, target, keyring: ring, sealer: createSealer(seededRng(4)), keyFile })
    expect(r.unreadable).toEqual([chunk])
    expect(r.deferred.length).toBe(2)
    expect(r.deferred).toContain(`bman/${blob}`)
    expect(r.ok).toBe(false)
    const keys = w.bucket.keys('new/').map((k) => k.slice(4))
    expect(keys).not.toContain(`bman/${blob}`)
    expect(keys.filter((k) => k.startsWith('seg/'))).toEqual([])
    // a future segment the build cannot read is copied as is
    const { MAGIC, keyFor } = await import('../log/codec')
    const v3 = new Uint8Array([...MAGIC, 3, 0])
    const future = keyFor({ v: 1, kind: 'seg', deviceId: 'future', seq: 0, createdAt: 0, blobRefs: [] }, v3)
    await old.put(future, v3)
    const t2 = memoryRemote({ bucket: w.bucket, prefix: 'new2' })
    const r2 = await sealDestination({
      source: old,
      target: t2,
      keyring: ring,
      sealer: createSealer(seededRng(5)),
      keyFile,
    })
    expect(w.bucket.keys('new2/')).toContain(`new2/${future}`)
    expect(r2.deferred.length).toBe(2)
    // a segment whose bytes match its name but are not an envelope is left out as unreadable
    const junk = new Uint8Array([1, 2, 3, 4, 1, 0])
    const junkKey = keyFor({ v: 1, kind: 'seg', deviceId: 'junk', seq: 0, createdAt: 0, blobRefs: [] }, junk)
    await old.put(junkKey, junk)
    const t3 = memoryRemote({ bucket: w.bucket, prefix: 'new3' })
    const r3 = await sealDestination({
      source: old,
      target: t3,
      keyring: ring,
      sealer: createSealer(seededRng(6)),
      keyFile,
    })
    expect(r3.unreadable).toContain(junkKey)
  })
})
