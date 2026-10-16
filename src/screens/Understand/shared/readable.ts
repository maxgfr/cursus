import type { SourceRecord } from '../../../core/model/schema'
import type { ModelWorkspace } from '../../../core/model/workspace'

/*
 * What a model can read in a source, without reading it: light enough for any screen (the reading itself is in
 * sources.ts, with the retrieval code).
 */

/** What is written about a photo: its caption, then the student's notes on it. */
export function photoText(caption: string | undefined, notes: string): string {
  return [caption ?? '', notes]
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .join('\n\n')
}

/** Whether the student wrote anything in a source's body: a note's text, their notes on a photo or a file. */
export function notesWritten(ws: ModelWorkspace, id: string): boolean {
  return ws.text({ id, field: 'body' }).toString().trim() !== ''
}

/**
 * Whether a model has anything to read in a source: a slide deck, a document or a PDF (their file), a note with
 * text, a photo with a caption, notes (`notes`) or a reading kept on this device (`read`). The pixels alone are
 * not read: a photo is read first (« Explain this photo »), by a model that sees images.
 */
export function isReadable(
  source: Pick<SourceRecord, 'kind' | 'support' | 'caption'>,
  written: { notes: boolean; read: boolean },
): boolean {
  if (source.support !== undefined || source.kind === 'pdf') return true
  if (source.kind === 'note') return written.notes
  return (source.caption ?? '').trim() !== '' || written.notes || written.read
}
