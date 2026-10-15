import type { DeckUnitImage, DeckUnitInput } from '../../core/ai/features/readDeck'
import { deckUnitInputs } from '../../core/ai/features/readDeck'
import { DeckError, type DeckImage, type DeckUnit, isVisionImage } from '../../core/content/deck'
import { ImageError, prepareImage } from '../../core/content/image'
import { openPdf } from '../../core/content/pdf'
import type { Id } from '../../core/contracts/workspace'
import type { SourceRecord } from '../../core/model/schema'
import type { ModelWorkspace } from '../../core/model/workspace'
import type { LoadedDeck } from '../DeckImport/deckSource.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'

/** Longest side of a picture sent to a vision model (what Claude, GPT and Gemini read without downscaling). */
const VISION_DIMENSION = 1568

export function unitsOf(loaded: LoadedDeck, indexes: readonly number[]): DeckUnit[] {
  const set = new Set(indexes)
  return loaded.deck.units.filter((u) => set.has(u.index))
}

/**
 * Model input for an estimate. A PDF page counts as one picture (rendered only when the run starts): its cost
 * when the model sees pictures, and a text-only notice when it does not.
 */
export function estimateInputs(loaded: LoadedDeck, indexes: readonly number[]): DeckUnitInput[] {
  const units = unitsOf(loaded, indexes)
  const pages = new Map<number, DeckUnitImage>()
  if (loaded.deck.format === 'pdf') {
    for (const u of units) {
      if (u.page !== undefined) pages.set(u.page, { bytes: new Uint8Array(), mediaType: 'image/jpeg' })
    }
  }
  return deckUnitInputs({ units, images: loaded.deck.images }, pages)
}

export interface RunInputs {
  units: DeckUnitInput[]
  /** Pictures that could not be prepared and were left out (the unit's text still goes). */
  leftOut: number
}

/**
 * Model input for a run. A model that sees pictures gets each unit's pictures downscaled, and each PDF page
 * rendered; one that does not gets text, notes and alternative texts only.
 */
export async function runInputs(
  loaded: LoadedDeck,
  indexes: readonly number[],
  vision: boolean,
  signal: AbortSignal,
): Promise<RunInputs> {
  const units = unitsOf(loaded, indexes)
  if (!vision) return { units: deckUnitInputs({ units, images: loaded.deck.images }), leftOut: 0 }
  let leftOut = 0
  const images = new Map<string, DeckImage>()
  const used = new Set(units.flatMap((u) => u.images.map((r) => r.id)))
  for (const id of used) {
    const img = loaded.deck.images.get(id)
    if (!img || !isVisionImage(img.mime)) continue
    signal.throwIfAborted()
    try {
      const prepared = await prepareImage(new Blob([new Uint8Array(img.bytes)], { type: img.mime }), {
        maxDimension: VISION_DIMENSION,
      })
      images.set(id, { id, mime: prepared.mime, bytes: new Uint8Array(await prepared.blob.arrayBuffer()) })
    } catch (e) {
      if (!(e instanceof ImageError)) throw e
      // An undecodable picture is left out; the unit's text still goes, and the screen says how many.
      noteError('deck.image', e)
      leftOut++
    }
  }
  const pages = new Map<number, DeckUnitImage>()
  const toRender = units.flatMap((u) => (u.page === undefined ? [] : [u.page]))
  if (toRender.length > 0) {
    const pdf = await openPdf(loaded.bytes, { signal })
    try {
      for (const page of toRender) {
        try {
          const blob = await pdf.render(page, { maxDimension: VISION_DIMENSION, mime: 'image/jpeg', quality: 0.8 })
          pages.set(page, { bytes: new Uint8Array(await blob.arrayBuffer()), mediaType: 'image/jpeg' })
        } catch (e) {
          // A page this browser cannot draw goes as text only, and the screen says how many.
          if (!(e instanceof DeckError)) throw e
          noteError('deck.render', e)
          leftOut++
        }
      }
    } finally {
      await pdf.close()
    }
  }
  return { units: deckUnitInputs({ units, images }, pages), leftOut }
}

/**
 * Saves reviewed questions as cards of the source's course (or of `sectionId`, a subset of it), in one batch.
 * Each card keeps its source and the slide, page or section it was made from (`unit`), so it can cite it.
 */
export function saveDraftCards(
  ws: ModelWorkspace,
  source: Pick<SourceRecord, 'id' | 'courseId'>,
  sectionId: string,
  drafts: readonly { unit: number; kind: 'basic' | 'cloze'; front: string; back: string }[],
): Id[] {
  const ids: Id[] = []
  ws.batch(() => {
    for (const d of drafts) {
      const id = ws.cards.create({
        courseId: source.courseId,
        ...(sectionId === '' ? {} : { sectionId }),
        kind: d.kind,
        origin: 'ai',
        sourceId: source.id,
        // 0 stands for the whole source: no unit to cite.
        ...(d.unit > 0 ? { unit: d.unit } : {}),
      })
      ws.text({ id, field: 'front' }).insert(0, d.front.trim())
      if (d.kind === 'basic' && d.back.trim()) ws.text({ id, field: 'back' }).insert(0, d.back.trim())
      ids.push(id)
    }
  })
  return ids
}
