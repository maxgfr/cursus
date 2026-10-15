/**
 * « Créer des cartes depuis cette photo »: flashcard drafts from one or several photos, read by a vision
 * model. Each draft may cite the photo it comes from; a citation of anything else is dropped. The caller
 * dedupes the drafts against the course (as « Générer » does) and saves only what the student confirms.
 * Usage is reported through `ctx.onUsage` as `photoToCards`.
 */
import type { CatalogModel } from '../catalogTrim'
import type { FeatureCtx } from '../client'
import { type CardDraft, generateCardsSchema } from '../schemas'
import { askAboutPhotos, estimatePhotoCost, type LabelledPhoto, PHOTOS_RULE } from './describePhoto'
import { fence } from './explainQuestion'

/** A photo to draft from: its id (its source id), its downscaled image and its caption. */
export type PhotoForCards = LabelledPhoto

export interface PhotoToCardsInput {
  photos: readonly PhotoForCards[]
  count: number
  allowCloze?: boolean
  courseTitle?: string
}

/** Answer tokens one draft takes, for the estimate. */
export const TOKENS_PER_CARD = 150

/** Estimated cost in USD of drafting `count` cards from `photos` photos. */
export function estimatePhotoCardsCost(info: CatalogModel, photos: number, count: number): number {
  return estimatePhotoCost(info, photos, TOKENS_PER_CARD * count)
}

export async function photoToCards(ctx: FeatureCtx, input: PhotoToCardsInput): Promise<CardDraft[]> {
  if (input.photos.length === 0) return []
  const kinds =
    input.allowCloze === false
      ? 'Only use kind "basic".'
      : 'Use kind "cloze" with {{c1::...}} deletions for facts and definitions, "basic" otherwise.'
  const system = [
    'You write atomic, unambiguous spaced-repetition flashcards from photos of course material',
    '(tables, slides, handwritten notes, diagrams): one fact per card, short answers, nothing the photos do not show.',
    kinds,
    PHOTOS_RULE,
    'Set sourceRef.sourceId to the id of the photo a card comes from; never set a page.',
    `Write in ${ctx.language}.`,
  ].join('\n')
  const course = input.courseTitle ? `Course: ${fence(input.courseTitle)}\n` : ''
  const out = await askAboutPhotos(ctx, {
    feature: 'photoToCards',
    system,
    prompt: `${course}Number of cards: ${input.count}\nPhotos: ${input.photos.length}`,
    photos: input.photos,
    schema: generateCardsSchema,
  })
  const ids = new Set(input.photos.map((p) => p.photoId))
  const cards: CardDraft[] = []
  for (const c of out.cards) {
    if (input.allowCloze === false && c.kind !== 'basic') continue
    const front = c.front.trim()
    if (front === '') continue
    const card: CardDraft = { kind: c.kind, front, back: c.back.trim() }
    if (c.sourceRef && ids.has(c.sourceRef.sourceId)) card.sourceRef = { sourceId: c.sourceRef.sourceId }
    cards.push(card)
    if (cards.length === input.count) break
  }
  return cards
}
