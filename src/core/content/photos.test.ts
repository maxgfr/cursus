import { describe, expect, test } from 'bun:test'
import { memoryStore } from '../storage/memoryStore'
import {
  blobIdOf,
  blobIdsIn,
  fitWithin,
  isHeic,
  isPhotoFile,
  keptOnDemand,
  normalizeRotation,
  PHOTO_MODE_KEY,
  photoMarkdown,
  photoRef,
  photosIn,
  readPhotoMode,
  shareText,
  turn,
  withoutPhoto,
  withPhoto,
  writePhotoMode,
} from './photos'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const named = (type: string, name: string) => Object.assign(new Blob([], { type }), { name })

describe('photo references', () => {
  test('a photo is named as cursus-blob:<h64>, never anything else', () => {
    expect(photoRef(A)).toBe(`cursus-blob:${A}`)
    expect(() => photoRef('nope')).toThrow(RangeError)
    expect(blobIdOf(`cursus-blob:${A}`)).toBe(A)
    expect(blobIdOf('cursus-blob:xyz')).toBeNull()
    expect(blobIdOf(undefined)).toBeNull()
  })

  test('Markdown images: added on their own paragraph, listed once, removed cleanly', () => {
    expect(photoMarkdown(A, 'The [board]\nnotes')).toBe(`![The board notes](cursus-blob:${A})`)
    const md = withPhoto('What does this show?', A, 'Board')
    expect(md).toBe(`What does this show?\n\n![Board](cursus-blob:${A})`)
    expect(withPhoto('', B, '')).toBe(`![](cursus-blob:${B})`)
    const both = withPhoto(withPhoto(md, B, 'Slide'), A, 'Again')
    expect(photosIn(both)).toEqual([
      { blobId: A, alt: 'Board' },
      { blobId: B, alt: 'Slide' },
    ])
    expect(withoutPhoto(both, A)).toBe(`What does this show?\n\n![Slide](cursus-blob:${B})`)
    expect(blobIdsIn(`<audio src="cursus-blob:${A}"></audio> ![x](cursus-blob:${B})`)).toEqual([A, B])
    expect(shareText(`Q\n\n![Board](cursus-blob:${A})\n\n<audio controls src="cursus-blob:${B}"></audio>`)).toBe(
      'Q\n\nBoard',
    )
  })
})

describe('photo geometry', () => {
  test('rotation is a quarter turn, normalised', () => {
    expect(normalizeRotation(undefined)).toBe(0)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(44)).toBe(0)
    expect(turn(270, 90)).toBe(0)
    expect(turn(0, -90)).toBe(270)
  })

  test('downscaling keeps the ratio and never upscales', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 })
    expect(fitWithin(3000, 1500, 2048)).toEqual({ width: 2048, height: 1024 })
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(1, 100000, 320)).toEqual({ width: 1, height: 320 })
  })

  test('accepted files: images by type, HEIC by type or name', () => {
    expect(isPhotoFile(named('image/png', 'a.png'))).toBe(true)
    expect(isPhotoFile(named('', 'IMG_1.HEIC'))).toBe(true)
    expect(isPhotoFile(named('application/pdf', 'a.pdf'))).toBe(false)
    expect(isHeic(named('image/heif', 'x'))).toBe(true)
    expect(isHeic(named('', 'x.heic'))).toBe(true)
    expect(isHeic(named('image/jpeg', 'x.jpg'))).toBe(false)
  })
})

describe('photos on this device', () => {
  test('a device setting in kv, "all" by default; only images wait on demand', async () => {
    const store = memoryStore()
    expect(await readPhotoMode(store)).toBe('all')
    expect(await keptOnDemand(store, 'image/jpeg')).toBe(false)
    await writePhotoMode(store, 'on-demand')
    expect(await store.read(['kv'], (tx) => tx.get('kv', PHOTO_MODE_KEY))).toBe('on-demand')
    expect(await keptOnDemand(store, 'image/jpeg')).toBe(true)
    expect(await keptOnDemand(store, 'application/pdf')).toBe(false)
    await store.commit([{ put: 'kv', key: PHOTO_MODE_KEY, value: 'garbage' }])
    expect(await readPhotoMode(store)).toBe('all')
  })
})
