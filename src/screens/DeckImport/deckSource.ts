import type { Runtime } from '../../app/workspaceContext.tsx'
import {
  type Deck,
  DeckError,
  type DeckFormat,
  type DeckUnit,
  importDeck,
  sourceFieldsOf,
} from '../../core/content/deck'
import type { LocalStore } from '../../core/contracts/ports'
import type { Id } from '../../core/contracts/workspace'
import { blobRef, blobStore } from '../../core/log/blobs'
import type { SourceRecord } from '../../core/model/schema'
import type { Translate } from '../../i18n/index.ts'

/** What the file pickers accept: the three formats a deck is read from. */
export const DECK_ACCEPT = [
  '.pptx',
  '.docx',
  '.pdf',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
].join(',')

const FORMAT_MIME: Readonly<Record<DeckFormat, string>> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
}

/** Whether a dropped or pasted file looks like a deck (the bytes decide later). */
export function isDeckFile(file: File): boolean {
  return /\.(pptx|docx|pdf)$/i.test(file.name) || Object.values(FORMAT_MIME).includes(file.type)
}

export interface LoadedDeck {
  deck: Deck
  /** The original file: PDF pages are rendered from it. */
  bytes: Uint8Array
}

/** The extracted text is a local cache, recomputed from the stored file: the last decks read stay in memory. */
const cache = new Map<string, Promise<LoadedDeck>>()
const CACHE_SIZE = 3

function remember(blobId: string, loaded: Promise<LoadedDeck>): Promise<LoadedDeck> {
  cache.delete(blobId)
  cache.set(blobId, loaded)
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  // A failed read is not kept: the next attempt reads again.
  loaded.catch(() => cache.delete(blobId))
  return loaded
}

/** The file of a deck source is not on this device yet (sync brings it later). */
export class DeckFileMissing extends Error {
  constructor() {
    super('the file of this source has not reached this device yet')
    this.name = 'DeckFileMissing'
  }
}

/** Reads a deck source back from its stored file. */
export function loadDeck(rt: Runtime, source: Pick<SourceRecord, 'blobId' | 'title'>): Promise<LoadedDeck> {
  const blobId = source.blobId
  if (blobId === undefined) return Promise.reject(new DeckFileMissing())
  const hit = cache.get(blobId)
  if (hit) return hit
  return remember(
    blobId,
    (async () => {
      const blob = await blobStore(rt.store).get(blobId)
      if (blob === null) throw new DeckFileMissing()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return { deck: await importDeck(bytes, { name: source.title }), bytes }
    })(),
  )
}

/**
 * Stores the original file and every image durably first, then creates the source in one atomic write: a
 * deck that fails to read never gets here, and a source never points at a file this device does not hold.
 * The images are listed as `cursus-blob:` references so sync sends them before the source.
 */
export async function saveDeckSource(
  rt: Runtime,
  where: { courseId: Id; sectionId?: Id },
  loaded: LoadedDeck,
  title: string,
): Promise<Id> {
  const fields = await storeDeckFiles(rt.store, loaded)
  return rt.ws.atomic(() => rt.ws.sources.create({ ...where, ...fields, title }))
}

/**
 * Stores a deck's original file and every image durably, and returns the fields of the source that will name
 * them: create it only once this resolves (the demo course does it inside its own atomic write).
 */
export async function storeDeckFiles(
  store: LocalStore,
  loaded: LoadedDeck,
): Promise<Pick<SourceRecord, 'kind' | 'support' | 'blobId' | 'blobIds'>> {
  const { deck, bytes } = loaded
  const blobs = blobStore(store)
  const fileId = await blobs.put(bytes, FORMAT_MIME[deck.format])
  const refs = new Set([blobRef(fileId)])
  for (const img of deck.images.values()) refs.add(blobRef(await blobs.put(img.bytes, img.mime)))
  remember(fileId, Promise.resolve(loaded))
  return { ...sourceFieldsOf(deck), blobId: fileId, blobIds: [...refs] }
}

/** « Slide 12 », « Page 7 », « Section 2.3 »: how a unit is cited. */
export function unitName(t: Translate, unit: Pick<DeckUnit, 'kind' | 'label'>): string {
  if (unit.kind === 'slide') return t('ai.deckSlide', { n: unit.label })
  if (unit.kind === 'page') return t('ai.deckPage', { n: unit.label })
  // A document's text before its first heading.
  return unit.label === '0' ? t('ai.deckIntro') : t('ai.deckSection', { n: unit.label })
}

/** « 4 slides », « 6 sections », « 3 pages ». */
export function unitCount(t: Translate, deck: Pick<Deck, 'units'>): string {
  const count = deck.units.length
  const kind = deck.units[0]?.kind ?? 'page'
  if (kind === 'slide') return t('ai.deckSlides', { count })
  if (kind === 'section') return t('ai.deckSections', { count })
  return t('ai.deckPages', { count })
}

function kindMessage(t: Translate, kind: DeckError['kind']): string {
  switch (kind) {
    case 'too-large':
      return t('ai.deckErrorTooLarge')
    case 'corrupt':
      return t('ai.deckErrorCorrupt')
    case 'encrypted':
      return t('ai.deckErrorEncrypted')
    case 'unsupported':
      return t('ai.deckErrorUnsupported')
    case 'unsafe':
      return t('ai.deckErrorUnsafe')
  }
}

/** A clear sentence for what went wrong reading or storing a file (the caller keeps the detail for diagnostics). */
export function deckErrorMessage(t: Translate, e: unknown): string {
  if (e instanceof DeckError) return kindMessage(t, e.kind)
  if (e instanceof DeckFileMissing) return t('ai.deckFileMissing')
  return t('ai.deckErrorOther', { reason: e instanceof Error ? e.message : String(e) })
}
