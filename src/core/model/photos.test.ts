import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import {
  exportCourse,
  exportCoursePackage,
  importCourse,
  importCoursePackage,
  readCourseFiles,
} from '../export/coursePackage'
import { blobStore } from '../log/blobs'
import { refsOf } from '../log/codec'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { memoryStore } from '../storage/memoryStore'
import {
  addPhoto,
  attachableSources,
  attachPhoto,
  countPhotos,
  getPhoto,
  listPhotos,
  photoLabel,
  photosAttachedTo,
  rotatePhoto,
  setCaption,
} from './photos'
import { createWorkspace } from './workspace'

function ws(seed = 1) {
  const doc = new Y.Doc()
  const clock = virtualClock(1_000)
  return { w: createWorkspace(doc, { rng: seededRng(seed, clock), clock, deviceId: `dev${seed}` }), clock, doc }
}

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('photos model', () => {
  test('a photo is an image source naming its file as cursus-blob: (sync closure)', () => {
    const { w, doc } = ws()
    const course = w.courses.create({ title: 'Law' })
    let update: Uint8Array | null = null
    doc.on('updateV2', (u: Uint8Array) => {
      update = u
    })
    const id = addPhoto(w, { courseId: course, title: 'Board', blobId: A, width: 2048, height: 1536 })
    expect(update).not.toBeNull()
    expect(refsOf(update ?? new Uint8Array())).toEqual([A])
    const s = w.sources.get(id)
    expect(s?.kind).toBe('image')
    expect(s?.blobId).toBe(A)
    expect(getPhoto(w, id)).toMatchObject({ title: 'Board', blobId: A, caption: '', rotation: 0, width: 2048 })
  })

  test('gallery per course and per subset, newest first; trash hides, restore brings back', () => {
    const { w, clock } = ws()
    const course = w.courses.create({ title: 'Law' })
    const torts = w.sections.create({ courseId: course, name: 'Torts' })
    const inner = w.sections.create({ courseId: course, parentId: torts, name: 'Negligence' })
    const root = addPhoto(w, { courseId: course, title: 'Root', blobId: A })
    clock.advance(1_000)
    const deep = addPhoto(w, { courseId: course, sectionId: inner, title: 'Deep', blobId: B })
    w.sources.create({ courseId: course, kind: 'note', title: 'Notes' })
    expect(listPhotos(w, { courseId: course }).map((p) => p.id)).toEqual([deep, root])
    expect(listPhotos(w, { courseId: course, sectionId: torts }).map((p) => p.id)).toEqual([deep])
    expect(countPhotos(w, { courseId: course })).toBe(2)
    w.sources.trash(deep)
    expect(getPhoto(w, deep)).toBeUndefined()
    expect(countPhotos(w, { courseId: course, sectionId: torts })).toBe(0)
    w.sources.restore(deep)
    expect(countPhotos(w, { courseId: course, sectionId: torts })).toBe(1)
    // A photo hidden in a trashed subset is not listed either (no cascade write).
    w.sections.trash(torts)
    expect(listPhotos(w, { courseId: course }).map((p) => p.id)).toEqual([root])
  })

  test('caption, rotation and attachment to a source of the same course', () => {
    const { w } = ws()
    const course = w.courses.create({ title: 'Law' })
    const other = w.courses.create({ title: 'Bio' })
    const note = w.sources.create({ courseId: course, kind: 'note', title: 'Lecture 3' })
    const elsewhere = w.sources.create({ courseId: other, kind: 'note', title: 'Cells' })
    const id = addPhoto(w, { courseId: course, title: 'IMG_1', blobId: A })
    setCaption(w, id, '  Duty of care  ')
    expect(getPhoto(w, id)?.caption).toBe('Duty of care')
    expect(photoLabel(getPhoto(w, id) ?? { caption: '', title: '' })).toBe('Duty of care')
    setCaption(w, id, ' ')
    expect(w.sources.get(id)?.caption).toBeUndefined()
    expect(rotatePhoto(w, id, -90)).toBe(270)
    expect(rotatePhoto(w, id, 90)).toBe(0)
    expect(w.sources.get(id)?.rotation).toBeUndefined()
    expect(attachableSources(w, course).map((s) => s.id)).toEqual([note])
    attachPhoto(w, id, note)
    expect(photosAttachedTo(w, note).map((p) => p.id)).toEqual([id])
    expect(() => attachPhoto(w, id, elsewhere)).toThrow(RangeError)
    expect(() => attachPhoto(w, id, id)).toThrow(RangeError)
    attachPhoto(w, id, null)
    expect(photosAttachedTo(w, note)).toEqual([])
  })
})

describe('course package with photos', () => {
  test('a shared then imported course keeps its photos, captions, rotation, attachment and card images', async () => {
    const { w } = ws()
    const store = memoryStore()
    const blobs = blobStore(store)
    const photoBytes = new Uint8Array(500).fill(9)
    const photo = await blobs.put(photoBytes, 'image/jpeg')
    const course = w.courses.create({ title: 'Law' })
    const note = w.sources.create({ courseId: course, kind: 'note', title: 'Lecture' })
    const id = addPhoto(w, { courseId: course, title: 'Board', blobId: photo, caption: 'Duty', attachedTo: note })
    rotatePhoto(w, id, 90)
    const card = w.cards.create({ courseId: course, kind: 'basic' })
    w.text({ id: card, field: 'front' }).insert(0, `What is shown?\n\n![Duty](cursus-blob:${photo})`)

    const { bytes, missing } = await exportCoursePackage(w, course, (fid) => blobs.get(fid))
    expect(missing).toBe(0)
    expect(readCourseFiles(bytes).map((f) => [f.id, f.mime, f.bytes.length])).toEqual([[photo, 'image/jpeg', 500]])

    // Another device, with an empty file store.
    const other = ws(2).w
    const otherStore = memoryStore()
    const otherBlobs = blobStore(otherStore)
    const imported = await importCoursePackage(other, otherBlobs, bytes)
    const [p] = listPhotos(other, { courseId: imported })
    expect(p).toMatchObject({ title: 'Board', caption: 'Duty', rotation: 90, blobId: photo })
    expect(other.sources.get(p?.id ?? '')?.photo).toBe(`cursus-blob:${photo}`)
    const lecture = other.sources.list({ courseId: imported }).find((s) => s.title === 'Lecture')
    expect(p?.attachedTo).toBe(lecture?.id as string)
    expect(await (await otherBlobs.get(photo))?.arrayBuffer()).toEqual(photoBytes.buffer)
    const [k] = other.cards.list({ courseId: imported })
    expect(other.text({ id: k?.id ?? '', field: 'front' }).toString()).toContain(`cursus-blob:${photo}`)
  })

  test('a file out of reach is left out and counted; older packages and plain imports still work', async () => {
    const { w } = ws()
    const course = w.courses.create({ title: 'Law' })
    addPhoto(w, { courseId: course, title: 'Board', blobId: A })
    const { bytes, missing } = await exportCoursePackage(w, course, async () => null)
    expect(missing).toBe(1)
    expect(readCourseFiles(bytes)).toEqual([])
    // Without the file, the photo keeps its id: it may be on that device already, or arrive by sync.
    const other = ws(3).w
    const id = importCourse(other, bytes)
    expect(listPhotos(other, { courseId: id })[0]?.blobId).toBe(A)
    expect(readCourseFiles(exportCourse(w, course))).toEqual([])
  })
})
