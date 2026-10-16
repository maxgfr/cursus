import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { pendingPair, tidyPair } from './livePlan.ts'

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

/** Formats turned on at the caret, waiting for what is typed next: nothing is written until then. */
export interface PendingFormat {
  pos: number
  markers: readonly Marker[]
}

export const setPendingFormat = StateEffect.define<PendingFormat | null>()

/**
 * The formats waiting at the caret (`toggleMarker` with nothing selected). They go once the caret moves, or with
 * what is typed (`typePending`); another device's edit only moves them.
 */
export const pendingFormat = StateField.define<PendingFormat | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPendingFormat)) return e.value
    if (value === null || tr.selection !== undefined) return null
    return tr.docChanged ? { pos: tr.changes.mapPos(value.pos, -1), markers: value.markers } : value
  },
})

const FORMAT_OF: Readonly<Record<Marker, Format>> = {
  '**': 'bold',
  '*': 'italic',
  '~~': 'strike',
  '`': 'code',
  $: 'math',
}

/** The parsed element a marker makes, and its marks' node. */
const NODE_OF: Readonly<Record<Marker, { node: string; mark: string }>> = {
  '**': { node: 'StrongEmphasis', mark: 'EmphasisMark' },
  '*': { node: 'Emphasis', mark: 'EmphasisMark' },
  '~~': { node: 'Strikethrough', mark: 'StrikethroughMark' },
  '`': { node: 'InlineCode', mark: 'CodeMark' },
  $: { node: 'InlineMath', mark: 'InlineMathMark' },
}

/**
 * The element of `marker`'s kind the caret is right inside of, at its very end (`end`) or its very start: the caret
 * then steps out of it instead of starting a new pair there.
 */
function edgeOf(state: EditorState, head: number, marker: Marker, side: 'end' | 'start'): SyntaxNode | null {
  const { node, mark } = NODE_OF[marker]
  const tree = syntaxTree(state)
  for (let n: SyntaxNode | null = tree.resolveInner(head, side === 'end' ? 1 : -1); n; n = n.parent) {
    if (n.name !== node) continue
    const marks = n.getChildren(mark)
    const edge = side === 'end' ? marks.at(-1) : marks[0]
    if (marks.length >= 2 && edge && (side === 'end' ? edge.from === head : edge.to === head)) return n
  }
  return null
}

/**
 * The format turned on or off at a caret, word-processor style. At the end of an element of that format the caret
 * steps out of it, as it does before one at its start; in a pair being typed into, it steps out and the pair is
 * tidied (`tidyPair`). Elsewhere nothing is written: the format waits for what is typed next (`pendingFormat`),
 * and asking again takes it back. Null for a selection, or several carets.
 */
export function toggleAtCaret(state: EditorState, marker: Marker): TransactionSpec | null {
  const { main } = state.selection
  if (state.selection.ranges.length > 1 || !main.empty) return null
  const head = main.head
  const end = edgeOf(state, head, marker, 'end')
  if (end) return { selection: EditorSelection.cursor(end.to) }
  const start = edgeOf(state, head, marker, 'start')
  if (start) return { selection: EditorSelection.cursor(start.from) }
  const pair = pendingPair(state, head)
  if (pair && state.doc.sliceString(pair.open.from, pair.open.to) === marker) {
    const tidy = tidyPair(state, pair) ?? []
    const changes = state.changes(tidy)
    return { changes, selection: EditorSelection.cursor(changes.mapPos(pair.close.to, 1)) }
  }
  const pending = state.field(pendingFormat, false) ?? null
  const markers = pending !== null && pending.pos === head ? pending.markers : []
  const next = markers.includes(marker) ? markers.filter((m) => m !== marker) : [...markers, marker]
  return { effects: setPendingFormat.of(next.length === 0 ? null : { pos: head, markers: next }) }
}

/**
 * Typing at the caret with formats waiting there: the text typed is written inside their markers, the caret before
 * the closing ones, so what follows is in the format too. White space typed first goes before the markers, and the
 * formats keep waiting. Null when nothing waits there: the text goes in as typed.
 */
export function typePending(state: EditorState, from: number, to: number, text: string): TransactionSpec | null {
  const pending = state.field(pendingFormat, false) ?? null
  if (pending === null || from !== to || from !== pending.pos || text === '' || text.includes('\n')) return null
  const body = text.trimStart()
  const space = text.slice(0, text.length - body.length)
  if (body === '') {
    return {
      changes: { from, insert: text },
      selection: EditorSelection.cursor(from + text.length),
      effects: setPendingFormat.of({ pos: from + text.length, markers: pending.markers }),
    }
  }
  const open = pending.markers.join('')
  const close = [...pending.markers].reverse().join('')
  return {
    changes: { from, insert: `${space}${open}${body}${close}` },
    selection: EditorSelection.cursor(from + space.length + open.length + body.length),
    effects: setPendingFormat.of(null),
  }
}

/** The formats waiting at the caret, and what typed text does with them (in the live view's text). */
export function pendingFormats(): Extension {
  return [
    pendingFormat,
    EditorView.inputHandler.of((view, from, to, text) => {
      // A composition (an IME, a dictation) is left as it comes.
      if (view.composing) return false
      const spec = typePending(view.state, from, to, text)
      if (spec === null) return false
      view.dispatch(spec, { scrollIntoView: true, userEvent: 'input.type' })
      return true
    }),
  ]
}

/**
 * Bold, italic, code or maths on the selection: applied by wrapping it, or taken off when it is already there, the
 * markers being around the selection or its first and last characters. A star run counts once for each: italic on
 * bold text makes it bold and italic. At a caret, see `toggleAtCaret`; an empty pair there is taken off.
 */
export function toggleMarker(state: EditorState, marker: Marker): TransactionSpec {
  const c = marker.charAt(0)
  const k = marker.length
  const { main } = state.selection
  if (state.selection.ranges.length === 1 && main.empty) {
    const around = Math.min(run(state, main.head, c, -1), run(state, main.head, c, 1))
    if (!applies(marker, around)) {
      const caret = toggleAtCaret(state, marker)
      if (caret !== null) return caret
    }
  }
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

const INLINE_FORMATS: ReadonlySet<Format> = new Set(['bold', 'italic', 'strike', 'code', 'math', 'link'])

/** The formats in effect where the caret is (at the selection's start). */
export function activeFormats(state: EditorState): Set<Format> {
  const out = new Set<Format>()
  const pos = state.selection.main.from
  const tree = syntaxTree(state)
  const seen = (n: SyntaxNode | null) => {
    for (; n; n = n.parent) {
      const f = NODE_FORMATS[n.name]
      // An inline element holds the caret only between its markers: right after one, what is typed is plain.
      if (f && (!INLINE_FORMATS.has(f) || (pos > n.from && pos < n.to))) out.add(f)
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
  // A format waiting at the caret turns it on for what is typed next, or off inside an element of its kind.
  const pending = state.field(pendingFormat, false) ?? null
  if (pending !== null && pending.pos === pos) {
    for (const m of pending.markers) {
      const f = FORMAT_OF[m]
      if (out.has(f)) out.delete(f)
      else out.add(f)
    }
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
