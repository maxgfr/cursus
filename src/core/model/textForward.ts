import type * as Y from 'yjs'

/**
 * Restores forward: rewrites only the span that differs between the current text and the chosen
 * version, so concurrent edits elsewhere in the text survive the merge.
 */
export function applyForward(text: Y.Text, target: string): void {
  const current = text.toString()
  if (current === target) return
  let start = 0
  const max = Math.min(current.length, target.length)
  while (start < max && current[start] === target[start]) start++
  let end = 0
  while (end < max - start && current[current.length - 1 - end] === target[target.length - 1 - end]) end++
  const removed = current.length - start - end
  if (removed > 0) text.delete(start, removed)
  const inserted = target.slice(start, target.length - end)
  if (inserted !== '') text.insert(start, inserted)
}
