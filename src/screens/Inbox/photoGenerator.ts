import type { Runtime } from '../../app/workspaceContext.tsx'
import type { QuestionGenerator } from '../../core/ai/autoQuestions'
import { CardTextIndex, type DeckQuestion, fixedQuestionCount } from '../../core/ai/features/deckQuestions'
import { canSeeImages, PHOTO_MAX_EDGE, VisionRequiredError } from '../../core/ai/features/describePhoto'
import { estimatePhotoCardsCost, photoToCards } from '../../core/ai/features/photoToCards'
import { renderPhoto } from '../../core/content/photos'
import { blobStore } from '../../core/log/blobs'
import { getPhoto } from '../../core/model/photos'

/** The photo, or its file, is not on this device (trashed meanwhile, or not synced down yet). */
export class PhotoFileMissing extends Error {
  constructor(id: string) {
    super(`the photo ${id} is not on this device`)
    this.name = 'PhotoFileMissing'
  }
}

/** The one unit a photo is read as. */
export const PHOTO_UNIT = 1

/**
 * Questions on a photo: `photoToCards` (a vision model reads it, upright and at most `PHOTO_MAX_EDGE` px) wrapped
 * as a generator whose questions all cite unit 1. Near-duplicates of the course's cards, of questions rejected
 * before and of each other are dropped, as `deckQuestions` does.
 */
export function photoGenerator(rt: Runtime): QuestionGenerator {
  return {
    estimate(info, input) {
      const units = input.resume?.done[PHOTO_UNIT] === undefined ? 1 : 0
      return {
        cost: units === 0 ? 0 : estimatePhotoCardsCost(info, 1, fixedQuestionCount(input.perUnit)),
        calls: units,
        units,
      }
    },
    async generate(ctx, input) {
      if (input.resume?.done[PHOTO_UNIT] !== undefined) return { questions: [], duplicates: 0 }
      if (!canSeeImages(ctx.info)) throw new VisionRequiredError(ctx.info.name)
      const photo = getPhoto(rt.ws, input.sourceId)
      const file = photo ? await blobStore(rt.store).get(photo.blobId) : null
      if (!photo || !file) throw new PhotoFileMissing(input.sourceId)
      const small = await renderPhoto(file, photo.rotation, PHOTO_MAX_EDGE)
      const image = { bytes: new Uint8Array(await small.arrayBuffer()), mediaType: small.type || 'image/jpeg' }
      const cards = await photoToCards(ctx, {
        photos: [{ photoId: input.sourceId, image, ...(photo.caption ? { caption: photo.caption } : {}) }],
        count: fixedQuestionCount(input.perUnit),
        allowCloze: input.types === undefined || input.types.includes('cloze'),
        ...(input.courseTitle ? { courseTitle: input.courseTitle } : {}),
      })
      const seen = new CardTextIndex(input.existing ?? [])
      const questions: DeckQuestion[] = []
      let duplicates = 0
      for (const c of cards) {
        const q: DeckQuestion = {
          kind: c.kind,
          type: c.kind === 'cloze' ? 'cloze' : 'qa',
          difficulty: 'medium',
          front: c.front,
          back: c.back,
          unit: PHOTO_UNIT,
          sourceRef: { sourceId: input.sourceId },
        }
        if (seen.has(q.front) || input.isDuplicate?.(q) === true) {
          duplicates++
          continue
        }
        seen.add(q.front)
        questions.push(q)
      }
      return { questions, duplicates }
    },
  }
}
