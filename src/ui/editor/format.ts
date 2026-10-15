import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'

/** Inline formats the toolbar toggles, by their Markdown marker. */
export type Marker = '**' | '*' | '`' | '$'

/** How many `c` sit right before `pos` (`dir` -1) or right after it (`dir` 1) on its line. */
function run(state: EditorState, pos: number, c: string, dir: -1 | 1): number {
  const line = state.doc.lineAt(pos)
  let n = 0
  for (let p = pos; dir < 0 ? p > line.from : p < line.to; p += dir) {
    const at = dir < 0 ? p - 1 : p
    if (state.doc.sliceString(at, at + 1) !== c) break
    n++
  }
  return n
}

/** Whether runs of `n` marker characters on both sides already apply `marker`. */
function applies(marker: Marker, n: number): boolean {
  if (marker === '**') return n >= 2
  if (marker === '*') return n === 1 || n >= 3
  return n === 1
}

/**
 * Bold, italic, code or maths on the selection: applied by wrapping it (a pair at the caret), or taken off when it
 * is already there, the markers being around the selection or its first and last characters. A star run counts
 * once for each: italic on bold text makes it bold and italic.
 */
export function toggleMarker(state: EditorState, marker: Marker): TransactionSpec {
  const c = marker.charAt(0)
  const k = marker.length
  return state.changeByRange((range) => {
    const outside = Math.min(run(state, range.from, c, -1), run(state, range.to, c, 1))
    if (applies(marker, outside)) {
      return {
        changes: [
          { from: range.from - k, to: range.from },
          { from: range.to, to: range.to + k },
        ],
        range: EditorSelection.range(range.from - k, range.to - k),
      }
    }
    if (range.to - range.from > 2 * k) {
      const inside = Math.min(run(state, range.from, c, 1), run(state, range.to, c, -1))
      if (applies(marker, inside) && range.to - range.from > 2 * inside) {
        return {
          changes: [
            { from: range.from, to: range.from + k },
            { from: range.to - k, to: range.to },
          ],
          range: EditorSelection.range(range.from, range.to - 2 * k),
        }
      }
    }
    return {
      changes: [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ],
      range: EditorSelection.range(range.from + k, range.to + k),
    }
  })
}

/**
 * Prefixes every selected line with `prefix` (takes it off when all lines have it). A caret at a line's start ends
 * up after the prefix, so what is typed next goes into the heading or the list item.
 */
export function prefixLines(state: EditorState, prefix: string): TransactionSpec {
  const numbers = new Set<number>()
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to; ) {
      const line = state.doc.lineAt(pos)
      numbers.add(line.number)
      pos = line.to + 1
    }
  }
  const lines = [...numbers].map((n) => state.doc.line(n))
  const remove = lines.every((l) => l.text.startsWith(prefix))
  const changes = state.changes(
    lines.map((l) => (remove ? { from: l.from, to: l.from + prefix.length } : { from: l.from, insert: prefix })),
  )
  return { changes, selection: state.selection.map(changes, 1) }
}

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/

/** Ticks (or unticks) the task items on the selected lines; null when there is none. */
export function toggleTask(state: EditorState): TransactionSpec | null {
  const changes: { from: number; to: number; insert: string }[] = []
  const seen = new Set<number>()
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to; ) {
      const line = state.doc.lineAt(pos)
      pos = line.to + 1
      if (seen.has(line.number)) continue
      seen.add(line.number)
      const m = TASK.exec(line.text)
      if (!m) continue
      const at = line.from + (m[1] ?? '').length
      changes.push({ from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' })
    }
  }
  return changes.length > 0 ? { changes } : null
}
