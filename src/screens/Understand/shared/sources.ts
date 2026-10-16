import type { Runtime } from '../../../app/workspaceContext.tsx'
import type { CatalogModel } from '../../../core/ai/catalogTrim'
import { costOf } from '../../../core/ai/cost'
import type { Chunk } from '../../../core/ai/retrieval'
import { contextBudget, estimateTokens } from '../../../core/ai/retrieval'
import type { DeckUnit } from '../../../core/content/deck'
import type { BlobStore } from '../../../core/contracts/log'
import type { SourceRecord } from '../../../core/model/schema'
import type { ModelWorkspace } from '../../../core/model/workspace'
import { photoText } from './readable.ts'

/** Source id used for text pasted straight into an AI screen (not saved, not linkable). */
export const PASTED = 'pasted'

const MAX_CHUNK = 2000

/** Splits text on blank lines into passages of at most ~MAX_CHUNK characters. */
export function splitText(sourceId: string, text: string, page?: number): Chunk[] {
  const out: Chunk[] = []
  let cur = ''
  const flush = () => {
    const t = cur.trim()
    if (t) out.push(page === undefined ? { sourceId, text: t } : { sourceId, page, text: t })
    cur = ''
  }
  for (const para of text.split(/\n\s*\n/)) {
    if (cur.length + para.length > MAX_CHUNK) flush()
    if (para.length > MAX_CHUNK) {
      for (let i = 0; i < para.length; i += MAX_CHUNK) {
        cur = para.slice(i, i + MAX_CHUNK)
        flush()
      }
      continue
    }
    cur += `${para}\n\n`
  }
  flush()
  return out
}

/** The units of a slide deck or document source, read from its stored file; null while that file is not here. */
export type DeckReader = (
  source: SourceRecord,
) => Promise<readonly Pick<DeckUnit, 'index' | 'title' | 'text' | 'notes'>[] | null>

/**
 * Reads deck sources the way the import does: from the stored file, through its cache of the last decks
 * read. The reader's code loads with the first deck source; a file sync has not brought yet is skipped.
 */
export function deckReader(rt: Runtime): DeckReader {
  return async (source) => {
    const { DeckFileMissing, loadDeck } = await import('../../DeckImport/deckSource.ts')
    try {
      return (await loadDeck(rt, source)).deck.units
    } catch (e) {
      if (e instanceof DeckFileMissing) return null
      throw e
    }
  }
}

/** A unit's text as the model reads it: title, body, speaker notes. */
function unitText(unit: Pick<DeckUnit, 'title' | 'text' | 'notes'>): string {
  return [unit.title, unit.text, unit.notes ? `Speaker notes: ${unit.notes}` : ''].filter((x) => x.trim()).join('\n\n')
}

/**
 * Passages of the chosen sources: note text, PDF pages, the slides, pages or sections of a deck or document
 * (their number kept as `page` for citations: the source view opens `?page=N` at unit N), what is written about a
 * photo (its caption and notes; what a model read on it is added by the caller, from this device).
 */
export async function chunksFor(
  ws: ModelWorkspace,
  blobs: BlobStore,
  sourceIds: readonly string[],
  pasted: string,
  readDeck: DeckReader,
): Promise<Chunk[]> {
  const out: Chunk[] = []
  for (const id of sourceIds) {
    const s = ws.sources.get(id)
    if (!s || s.deletedAt !== undefined) continue
    if (s.support !== undefined) {
      // A deck's text lives in its file, not in the note body.
      for (const unit of (await readDeck(s)) ?? []) out.push(...splitText(id, unitText(unit), unit.index))
    } else if (s.kind === 'note') {
      out.push(...splitText(id, ws.text({ id, field: 'body' }).toString()))
    } else if (s.kind === 'image') {
      out.push(...splitText(id, photoText(s.caption, ws.text({ id, field: 'body' }).toString())))
    } else if (s.kind === 'pdf') {
      const blobId = s.blobId ?? s.blobIds?.[0]
      const blob = blobId ? await blobs.get(blobId) : null
      if (!blob) continue
      const { extractPdfText } = await import('../../../core/content/pdf')
      const pages = await extractPdfText(new Uint8Array(await blob.arrayBuffer()))
      pages.forEach((text, i) => {
        out.push(...splitText(id, text, i + 1))
      })
    }
  }
  if (pasted.trim()) out.push(...splitText(PASTED, pasted))
  return out
}

/** Rough cost of one call: the grounded prompt (capped by the context budget) plus a typical answer. */
export function estimateCost(info: CatalogModel, chunks: readonly Chunk[], outputTokens = 1500): number {
  const prompt = 400 + chunks.reduce((n, c) => n + estimateTokens(c.text) + 16, 0)
  const inputTokens = Math.min(prompt, contextBudget(info.context_length))
  return costOf({ inputTokens, outputTokens }, info.cost)
}
