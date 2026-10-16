/**
 * Text an AI writes into an editor as it comes: whole lines only (a heading, a list marker or a link half-written
 * would flash), each change the smallest that turns what is written into what is to be, so the text never jumps.
 * Pure: the editor applies it (`EditorWriter` in MarkdownEditorImpl.tsx).
 */

/** A change of the written text: `from`–`to` (in it) replaced by `insert`. */
export interface WriteStep {
  from: number
  to: number
  insert: string
}

/**
 * What turns `written` into `next`: the common start kept, the rest replaced (the model may rewrite what it wrote,
 * as a final check of its citations does). Until `final`, the unfinished last line of `next` waits. Null: nothing
 * to change yet.
 */
export function planWrite(written: string, next: string, final: boolean): WriteStep | null {
  const target = final ? next : next.slice(0, next.lastIndexOf('\n') + 1)
  // A partial answer can briefly end before what was written (a line still being completed): nothing is taken back
  // until the text really says otherwise.
  if (!final && written.startsWith(target)) return null
  if (target === written) return null
  let common = 0
  const max = Math.min(written.length, target.length)
  while (common < max && written.charCodeAt(common) === target.charCodeAt(common)) common++
  return { from: common, to: written.length, insert: target.slice(common) }
}

/** Applies a step to the written text (what the editor holds after it). */
export function applyStep(written: string, step: WriteStep): string {
  return written.slice(0, step.from) + step.insert + written.slice(step.to)
}

/** Writes an AI's text into an editor, one undo step in all; read-only while it writes. */
export interface EditorWriter {
  /** Starts writing at the end of the text, after a blank line when there is text already; false if it cannot. */
  begin(): boolean
  /** The text written so far (Markdown); `final` for the whole of it, its last line included. */
  write(text: string, final?: boolean): void
  /** Ends: what is written stays, editable again; one undo takes it all back. */
  end(): void
}
