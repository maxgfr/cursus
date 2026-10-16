import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

/** Inline formats the toolbar toggles, by their Markdown marker. */
export type Marker = '**' | '*' | '~~' | '`' | '$'

/** Everything the toolbar applies, and shows as on (`aria-pressed`) where the caret is. */
export type Format =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'numbered'
  | 'task'
  | 'quote'
  | 'link'
  | 'code'
  | 'math'
  | 'table'

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
  if (marker === '~~') return n === 2
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

/** The lines the selection covers, each once, in order. */
function selectedLines(state: EditorState) {
  const numbers = new Set<number>()
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to; ) {
      const line = state.doc.lineAt(pos)
      numbers.add(line.number)
      pos = line.to + 1
    }
  }
  return [...numbers].sort((a, b) => a - b).map((n) => state.doc.line(n))
}

/** Rewrites the start of each line (`[from, to)` relative to it, as `prefixOf` finds it) with `insert`. */
function rewriteStarts(
  state: EditorState,
  edits: readonly { line: { from: number }; to: number; insert: string }[],
): TransactionSpec {
  const changes = state.changes(edits.map((e) => ({ from: e.line.from, to: e.line.from + e.to, insert: e.insert })))
  return { changes, selection: state.selection.map(changes, 1) }
}

const HEADING = /^(#{1,6})[ \t]+/

/** Makes the selected lines headings of `level`; lines already at that level go back to text. */
export function setHeading(state: EditorState, level: 1 | 2 | 3): TransactionSpec {
  const lines = selectedLines(state)
  const all = lines.every((l) => HEADING.exec(l.text)?.[1]?.length === level)
  return rewriteStarts(
    state,
    lines.map((l) => ({
      line: l,
      to: HEADING.exec(l.text)?.[0].length ?? 0,
      insert: all ? '' : `${'#'.repeat(level)} `,
    })),
  )
}

/** A list item's start: indentation, marker and, for a task, its box. */
const ITEM = /^([ \t]*)(?:([-*+])|(\d+)[.)])[ \t]+(\[[ xX]\][ \t]+)?/

export type ListKind = 'bullet' | 'numbered' | 'task'

function kindOf(m: RegExpExecArray | null): ListKind | null {
  if (!m) return null
  if (m[4]) return 'task'
  return m[2] ? 'bullet' : 'numbered'
}

/**
 * Makes the selected lines items of a bulleted, numbered or task list (numbered 1, 2, 3…), keeping their
 * indentation; when they all already are, they go back to text.
 */
export function toggleList(state: EditorState, kind: ListKind): TransactionSpec {
  const lines = selectedLines(state)
  const all = lines.every((l) => kindOf(ITEM.exec(l.text)) === kind)
  return rewriteStarts(
    state,
    lines.map((l, i) => {
      const m = ITEM.exec(l.text)
      const indent = m?.[1] ?? ''
      const marker = kind === 'numbered' ? `${i + 1}. ` : kind === 'task' ? '- [ ] ' : '- '
      return { line: l, to: m?.[0].length ?? 0, insert: all ? indent : `${indent}${marker}` }
    }),
  )
}

/** Quotes the selected lines, or unquotes them when they all are. */
export function toggleQuote(state: EditorState): TransactionSpec {
  const lines = selectedLines(state)
  const all = lines.every((l) => /^>/.test(l.text))
  return rewriteStarts(
    state,
    lines.map((l) => ({ line: l, to: all ? (/^> ?/.exec(l.text)?.[0].length ?? 0) : 0, insert: all ? '' : '> ' })),
  )
}

/**
 * What a typed character turns into, word-processor style, when Markdown alone would not do it: `[]` or `[ ]`
 * followed by a space at a line's start (or after a list marker) becomes a task. Null: type it as is.
 */
export function inputRule(state: EditorState, from: number, to: number, text: string): TransactionSpec | null {
  if (text !== ' ' || from !== to) return null
  const line = state.doc.lineAt(from)
  const before = state.doc.sliceString(line.from, from)
  const m = /^([ \t]*)(?:([-*+]|\d+[.)])[ \t]+)?\[ ?\]$/.exec(before)
  if (!m) return null
  const insert = `${m[1] ?? ''}${m[2] ?? '-'} [ ] `
  return {
    changes: { from: line.from, to: from, insert },
    selection: EditorSelection.cursor(line.from + insert.length),
  }
}

/** What precedes the caret when it sits right after a line's formatting: quotes, indentation, then one marker. */
const LINE_FORMAT = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?$/

/**
 * Backspace right after a line's formatting takes the formatting off, as a word processor does: a heading, a list
 * item or a task becomes text (inside a quote, the quote stays), then a quote's `>` goes. Null elsewhere.
 */
export function unformatLine(state: EditorState): TransactionSpec | null {
  const { main } = state.selection
  if (state.selection.ranges.length > 1 || !main.empty) return null
  const line = state.doc.lineAt(main.head)
  const before = state.doc.sliceString(line.from, main.head)
  if (before === '') return null
  const m = LINE_FORMAT.exec(before)
  if (!m) return null
  const quotes = m[1] ?? ''
  if (m[3]) {
    const from = line.from + quotes.length
    return { changes: { from, to: main.head }, selection: EditorSelection.cursor(from) }
  }
  if (quotes === '') return null
  const last = /[ \t]*>[ \t]?$/.exec(quotes)
  const from = line.from + quotes.length - (last?.[0].length ?? 0)
  return { changes: { from, to: main.head }, selection: EditorSelection.cursor(from) }
}

/** A list item or a task with nothing written in it yet (inside quotes, maybe). */
const EMPTY_ITEM = /^((?:[ \t]*>[ \t]?)*)[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]*)?$/

/**
 * Enter on an empty list item or task leaves the list: the item goes, and a blank line sets what is typed next
 * apart from the list (inside a quote, the quote stays). Null elsewhere.
 */
export function leaveEmptyItem(state: EditorState): TransactionSpec | null {
  const { main } = state.selection
  if (state.selection.ranges.length > 1 || !main.empty) return null
  const line = state.doc.lineAt(main.head)
  if (main.head !== line.to) return null
  const m = EMPTY_ITEM.exec(line.text)
  if (!m) return null
  const quotes = m[1] ?? ''
  const before = line.number > 1 ? state.doc.line(line.number - 1).text : ''
  const insert = quotes === '' && before.trim() !== '' ? '\n' : quotes
  return {
    changes: { from: line.from, to: line.to, insert },
    selection: EditorSelection.cursor(line.from + insert.length),
  }
}

const NODE_FORMATS: Readonly<Record<string, Format>> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  Strikethrough: 'strike',
  InlineCode: 'code',
  InlineMath: 'math',
  BlockMath: 'math',
  Link: 'link',
  Table: 'table',
  ATXHeading1: 'h1',
  ATXHeading2: 'h2',
  ATXHeading3: 'h3',
  SetextHeading1: 'h1',
  SetextHeading2: 'h2',
  Blockquote: 'quote',
}

/** The formats in effect where the caret is (at the selection's start). */
export function activeFormats(state: EditorState): Set<Format> {
  const out = new Set<Format>()
  const pos = state.selection.main.from
  const tree = syntaxTree(state)
  const seen = (n: SyntaxNode | null) => {
    for (; n; n = n.parent) {
      const f = NODE_FORMATS[n.name]
      if (f) out.add(f)
      if (n.name === 'ListItem') {
        const list = n.parent?.name
        if (n.getChild('Task')) out.add('task')
        else if (list === 'OrderedList') out.add('numbered')
        else if (list === 'BulletList') out.add('bullet')
      }
    }
  }
  seen(tree.resolveInner(pos, -1))
  seen(tree.resolveInner(pos, 1))
  // A list item holds the task, the bullet or the number only once: the innermost one counts.
  const item = [tree.resolveInner(pos, -1), tree.resolveInner(pos, 1)]
    .map((n) => {
      for (let p: SyntaxNode | null = n; p; p = p.parent) if (p.name === 'ListItem') return p
      return null
    })
    .find((n) => n !== null)
  if (item) {
    out.delete('task')
    out.delete('bullet')
    out.delete('numbered')
    if (item.getChild('Task')) out.add('task')
    else if (item.parent?.name === 'OrderedList') out.add('numbered')
    else out.add('bullet')
  }
  return out
}

/** A link's address as Markdown writes it: in angle brackets when it holds spaces or parentheses. */
export function linkAddress(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url
}

/** A link's Markdown: its text kept as typed (brackets escaped), then its address. */
export function linkMarkdown(text: string, url: string): string {
  return `[${text.replace(/[[\]]/g, (c) => `\\${c}`)}](${linkAddress(url)})`
}

/** A formula's Markdown: `$…$` in a line, `$$` lines around a displayed one. */
export function mathMarkdown(latex: string, block: boolean): string {
  const tex = latex.trim()
  return block ? `$$\n${tex}\n$$` : `$${tex}$`
}

/** The cells of a table's source, row by row: the header first, the delimiter line left out. */
export function parseTable(source: string): string[][] {
  const rows: string[][] = []
  source.split('\n').forEach((text, i) => {
    if (i === 1) return
    let row = text.trim()
    if (row.startsWith('|')) row = row.slice(1)
    if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
    const cells: string[] = []
    let cell = ''
    for (let k = 0; k < row.length; k++) {
      const c = row.charAt(k)
      if (c === '\\' && row.charAt(k + 1) === '|') {
        cell += '|'
        k++
      } else if (c === '|') {
        cells.push(cell.trim())
        cell = ''
      } else cell += c
    }
    cells.push(cell.trim())
    rows.push(cells)
  })
  const width = Math.max(1, ...rows.map((r) => r.length))
  return rows.map((r) => Array.from({ length: width }, (_, k) => r[k] ?? ''))
}

/** A table's Markdown from its cells (the first row is the header); a `|` in a cell is escaped. */
export function tableMarkdown(rows: readonly (readonly string[])[]): string {
  const width = Math.max(1, ...rows.map((r) => r.length))
  const line = (r: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, k) => (r[k] ?? '').replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()).join(' | ')} |`
  const [header = [], ...body] = rows
  return [line(header), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n')
}
