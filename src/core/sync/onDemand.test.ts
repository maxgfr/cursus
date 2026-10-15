import { describe, expect, test } from 'bun:test'
import type { Key, RemoteStore } from '../contracts/remote'
import { blobRef } from '../log/blobs'
import { bmanKey } from '../log/codec'
import { addPhoto } from '../model/photos'
import { all, device, world } from './harness.test'

async function keysOf(r: RemoteStore, prefix = ''): Promise<Key[]> {
  return (await all(r.list(prefix))).map((e) => e.key)
}

/** A device A that took a photo and imported a PDF, synced to one destination. */
async function sharedLibrary() {
  const w = world()
  const a = await device(1, w.clock)
  const ra = a.engine.addDest({ remote: w.remote() })
  const photo = await a.blobs.put(new Uint8Array(300).fill(5), 'image/jpeg')
  const pdf = await a.blobs.put(new Uint8Array(200).fill(6), 'application/pdf')
  const course = a.ws.courses.create({ title: 'Bio' })
  addPhoto(a.ws, { courseId: course, title: 'Board', blobId: photo })
  a.ws.sources.create({ courseId: course, kind: 'pdf', title: 'Scan', blobId: blobRef(pdf) })
  await a.commit()
  await a.engine.round(ra)
  return { w, a, photo, pdf }
}

describe('photos on demand', () => {
  test('a photo stays listed, its chunks wait on the destination until opened; other files come down', async () => {
    const { w, photo, pdf } = await sharedLibrary()
    const remoteBefore = await keysOf(w.remote())
    const b = await device(2, w.clock, { onDemand: (mime) => mime.startsWith('image/') })
    const rb = b.engine.addDest({ remote: w.remote() })
    await b.engine.round(rb)
    expect(b.ws.sources.list().map((s) => s.title)).toEqual(expect.arrayContaining(['Board', 'Scan']))
    expect(await b.blobs.read(bmanKey(photo))).not.toBeNull()
    expect(await b.blobs.get(photo)).toBeNull()
    expect(await b.blobs.get(pdf)).not.toBeNull()
    // Not counted as "incoming" forever, and an incremental round leaves it there too.
    expect(b.engine.status().dests[0]?.incoming).toBe(0)
    await b.engine.round(rb)
    expect(await b.blobs.get(photo)).toBeNull()

    // Opening the photo downloads it, from whichever destination has it.
    expect(await b.engine.fetchBlob(photo)).toBe(true)
    expect(await (await b.blobs.get(photo))?.arrayBuffer()).toEqual(new Uint8Array(300).fill(5).buffer)
    // Nothing was ever removed from the destination.
    expect(await keysOf(w.remote())).toEqual(expect.arrayContaining(remoteBefore))
  })

  test('switching back to "all" brings the waiting photos at the next round', async () => {
    const { w, photo } = await sharedLibrary()
    let onDemand = true
    const b = await device(2, w.clock, { onDemand: (mime) => onDemand && mime.startsWith('image/') })
    const rb = b.engine.addDest({ remote: w.remote() })
    await b.engine.round(rb)
    expect(await b.blobs.get(photo)).toBeNull()
    onDemand = false
    await b.engine.round(rb)
    expect(await b.blobs.get(photo)).not.toBeNull()
  })

  test('an on-demand device still relays a photo to a destination that lacks it (fetched from the other)', async () => {
    const { w, photo } = await sharedLibrary()
    const b = await device(2, w.clock, { onDemand: (mime) => mime.startsWith('image/') })
    const first = b.engine.addDest({ remote: w.remote() })
    await b.engine.round(first)
    expect(await b.blobs.get(photo)).toBeNull()
    const second = b.engine.addDest({ remote: w.remote('d2') })
    await b.engine.round(second)
    const keys = await keysOf(w.remote('d2'))
    expect(keys).toContain(bmanKey(photo))
    expect(keys.filter((k) => k.startsWith('seg/')).length).toBeGreaterThan(0)
  })

  test('fetchBlob answers false when no destination holds the file', async () => {
    const w = world()
    const b = await device(2, w.clock)
    b.engine.addDest({ remote: w.remote() })
    expect(await b.engine.fetchBlob('a'.repeat(64))).toBe(false)
  })
})
