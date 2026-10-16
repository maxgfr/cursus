import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { GFM } from '@lezer/markdown'
import { clozeSpans } from '../../core/model/cloze'
import { mathSyntax } from './mathSyntax.ts'

/** The Markdown the renderer reads: CommonMark, GFM (tables, task lists, ~~strikethrough~~, autolinks) and maths. */
export function liveMarkdown(): Extension {
  return markdown({ base: commonmarkLanguage, extensions: [GFM, mathSyntax] })
}

/** A stored photo in the text (`![caption](cursus-blob:<sha256>)`). */
export const PHOTO = /!\[([^\]\n]*)\]\(cursus-blob:([0-9a-f]{64})\)/g

/** A stretch of the text. */
export interface Span {
  from: number
  to: number
}

/**
 * What the live editor draws over the source, position by position. Pure: computed from the syntax tree and the
 * selection, turned into CodeMirror decorations by `livePreview.ts`.
 */
export type LiveItem =
  /** Syntax hidden (`**`, `#`, `>`, a link's URL…): the text reads as written, never as Markdown. */
  | { kind: 'hide'; from: number; to: number }
  /** Inline styling (`cm-md-strong`, `cm-md-code`, `cm-md-mark` for visible syntax…). */
  | { kind: 'mark'; from: number; to: number; cls: string }
  /** A class (and attributes) on the line that starts at `at`. */
  | { kind: 'line'; at: number; cls: string; attrs?: Readonly<Record<string, string>> }
  /** `$…$` (inline) or whole `$$…$$` lines (block), drawn with KaTeX. */
  | { kind: 'math'; from: number; to: number; source: string; block: boolean }
  /** Whole table lines, drawn as the table. */
  | { kind: 'table'; from: number; to: number; source: string }
  /** A list marker (and its indentation), drawn as the bullet or number. */
  | { kind: 'listMark'; from: number; to: number; label: string; depth: number }
  /** `[ ]` / `[x]` of a task item, drawn as a checkbox; `text` is the task it ticks. */
  | { kind: 'task'; from: number; to: number; checked: boolean; text: string }
  /** `---`, drawn as the rule. */
  | { kind: 'rule'; from: number; to: number }
  /** A stored photo; `alone` when its line holds nothing else (its reference is never shown). */
  | {
      kind: 'photo'
      from: number
      to: number
      sha: string
      alt: string
      lineFrom: number
      lineTo: number
      alone: boolean
    }

export interface PlanOptions {
  /**
   * Where the little syntax that is edited as typed comes back (a code block's fences, a cloze's braces): the
   * selection by default. The view holds it still while a pointer selects, so the text does not move under it.
   */
  reveal?: readonly Span[]
  /** Only the blocks over this stretch are planned (the part of the text near the screen); the whole text by default. */
  within?: Span
  /** Whether `{{cN::…}}` deletions are read: only a cloze card's text has them (default true). */
  cloze?: boolean
}

const LIST = new Set(['BulletList', 'OrderedList'])
/** Where cloze, photos and typing-in-progress emphasis are not read: code and maths are literal. */
const VERBATIM = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'InlineMath', 'BlockMath'])
/** Nodes whose delimiters are not pending emphasis. */
const NOT_PENDING = new Set([
  ...VERBATIM,
  'Emphasis',
  'StrongEmphasis',
  'Strikethrough',
  'Link',
  'URL',
  'Autolink',
  'Image',
  'Escape',
  'ListMark',
  'QuoteMark',
  'HeaderMark',
  'HorizontalRule',
  'TaskMarker',
  'HTMLTag',
])
const SPACE = /[ \t]/

/** Whether any of `ranges` touches `from`–`to` (a caret at either end counts). */
function toucher(ranges: readonly Span[]) {
  return (from: number, to: number) => ranges.some((r) => r.from <= to && r.to >= from)
}

function revealOf(state: EditorState, focused: boolean, options: PlanOptions): readonly Span[] {
  return focused ? (options.reveal ?? state.selection.ranges) : []
}

/**
 * The decorations of a live Markdown view: `focused` false draws everything as rendered. The inline part and the
 * drawn blocks (`planInline` and `planBlocks`), together.
 */
export function planLive(state: EditorState, focused: boolean, options: PlanOptions = {}): LiveItem[] {
  return [...planInline(state, focused, options), ...planBlocks(state)]
}

/** The top-level block that holds `pos`, or `pos` itself between blocks. */
function blockEdge(tree: Tree, pos: number, side: -1 | 1): number {
  let node: SyntaxNode | null = tree.resolveInner(pos, side)
  while (node?.parent && node.parent.name !== 'Document') node = node.parent
  if (!node || node.name === 'Document') return pos
  return side < 0 ? Math.min(node.from, pos) : Math.max(node.to, pos)
}

/**
 * Everything drawn in the lines of the text (styles, hidden syntax, inline widgets), over `within` widened to whole
 * blocks. What a drawn block covers (`planBlocks`) is left out.
 */
export function planInline(state: EditorState, focused: boolean, options: PlanOptions = {}): LiveItem[] {
  const { doc } = state
  const within = options.within ?? { from: 0, to: doc.length }
  const tree = ensureSyntaxTree(state, Math.min(doc.length, within.to), 200) ?? syntaxTree(state)
  const start = blockEdge(tree, Math.max(0, within.from), -1)
  const end = blockEdge(tree, Math.min(doc.length, within.to), 1)
  const touches = toucher(revealOf(state, focused, options))
  const out: LiveItem[] = []
  const verbatim: [number, number][] = []
  const hide = (from: number, to: number) => {
    if (to > from) out.push({ kind: 'hide', from, to })
  }
  const mark = (from: number, to: number, cls: string) => {
    if (to > from) out.push({ kind: 'mark', from, to, cls })
  }
  const line = (pos: number, cls: string, attrs?: Readonly<Record<string, string>>) => {
    out.push({ kind: 'line', at: doc.lineAt(pos).from, cls, ...(attrs ? { attrs } : {}) })
  }
  const lines = (from: number, to: number, cls: string) => {
    for (let n = doc.lineAt(from).number, last = doc.lineAt(to).number; n <= last; n++) line(doc.line(n).from, cls)
  }
  /** Syntax shown dimmed while the caret is on its element, hidden otherwise (fences, cloze braces). */
  const syntax = (from: number, to: number, active: boolean) => (active ? mark(from, to, 'cm-md-mark') : hide(from, to))
  const children = (node: SyntaxNode, name: string) => {
    for (const c of node.getChildren(name)) hide(c.from, c.to)
  }
  /** A block marker (`#`, `>`, `-`) counts once a space follows it: a lone `#` or `-` being typed shows as typed. */
  const spaced = (to: number) => SPACE.test(doc.sliceString(to, to + 1))
  const spacesAfter = (pos: number) => {
    let p = pos
    while (p < doc.length && SPACE.test(doc.sliceString(p, p + 1))) p++
    return p
  }
  const spacesBefore = (pos: number, floor: number) => {
    let p = pos
    while (p > floor && SPACE.test(doc.sliceString(p - 1, p))) p--
    return p
  }
  const listDepth = (list: SyntaxNode) => {
    let depth = 0
    for (let p: SyntaxNode | null = list; p; p = p.parent) if (LIST.has(p.name)) depth++
    return depth
  }

  tree.iterate({
    from: start,
    to: end,
    enter: (ref) => {
      const node = ref.node
      const { from, to } = node
      const heading = /^ATXHeading([1-6])$/.exec(node.name)
      if (heading) {
        const level = Number(heading[1])
        // Nested under the screen's own title: a note's `#` is the screen's second level.
        line(from, `cm-md-h cm-md-h${level}`, { role: 'heading', 'aria-level': String(Math.min(6, level + 1)) })
        return
      }
      switch (node.name) {
        case 'SetextHeading1':
        case 'SetextHeading2': {
          const level = node.name === 'SetextHeading1' ? 1 : 2
          const underline = node.getChild('HeaderMark')
          const last = underline ? doc.lineAt(underline.from).number - 1 : doc.lineAt(to).number
          for (let n = doc.lineAt(from).number; n <= last; n++) {
            line(
              doc.line(n).from,
              `cm-md-h cm-md-h${level}`,
              n === doc.lineAt(from).number ? { role: 'heading', 'aria-level': String(level + 1) } : undefined,
            )
          }
          if (underline) hide(underline.from, underline.to)
          return false
        }
        case 'HeaderMark': {
          const parent = node.parent
          if (parent && from === parent.from) {
            if (spaced(to)) hide(from, spacesAfter(to))
            else mark(from, to, 'cm-md-mark')
          } else hide(spacesBefore(from, doc.lineAt(from).from), to)
          return
        }
        case 'Emphasis':
          mark(from, to, 'cm-md-em')
          children(node, 'EmphasisMark')
          return
        case 'StrongEmphasis':
          mark(from, to, 'cm-md-strong')
          children(node, 'EmphasisMark')
          return
        case 'Strikethrough':
          mark(from, to, 'cm-md-strike')
          children(node, 'StrikethroughMark')
          return
        case 'InlineCode':
          verbatim.push([from, to])
          mark(from, to, 'cm-md-code')
          children(node, 'CodeMark')
          return false
        case 'InlineMath':
          verbatim.push([from, to])
          out.push({ kind: 'math', from, to, source: doc.sliceString(from, to), block: false })
          return false
        case 'BlockMath':
          verbatim.push([from, to])
          // Drawn whole by `planBlocks`; nested in a list or a quote, its lines read as source.
          if (node.parent?.name === 'Document') return false
          lines(from, to, 'cm-md-mathLine')
          for (const c of node.getChildren('BlockMathMark')) mark(c.from, c.to, 'cm-md-mark')
          return false
        case 'Link': {
          const [open, close] = node.getChildren('LinkMark')
          if (!open || !close || close.from < open.to) return
          mark(open.to, close.from, 'cm-md-link')
          hide(open.from, open.to)
          hide(close.from, to)
          return
        }
        case 'Autolink': {
          const url = node.getChild('URL')
          if (url) mark(url.from, url.to, 'cm-md-link')
          children(node, 'LinkMark')
          return false
        }
        case 'URL':
          // A bare address (GFM autolink): links only inside text, not in a link's or image's own syntax.
          if (node.parent?.name !== 'Link' && node.parent?.name !== 'Image' && node.parent?.name !== 'LinkReference') {
            mark(from, to, 'cm-md-link')
          }
          return
        case 'Image':
          return false
        case 'Escape':
          hide(from, from + 1)
          return
        case 'Blockquote':
          lines(from, to, 'cm-md-quote')
          return
        case 'QuoteMark':
          if (spaced(to)) hide(from, Math.min(spacesAfter(to), to + 1))
          else if (doc.lineAt(from).to > to) hide(from, to)
          else mark(from, to, 'cm-md-mark')
          return
        case 'ListMark': {
          const item = node.parent
          const list = item?.parent
          if (!item || !list || !LIST.has(list.name)) return
          const depth = listDepth(list)
          const l = doc.lineAt(from)
          const start = spacesBefore(from, l.from)
          line(from, 'cm-md-li', { style: `--md-depth: ${depth}` })
          // A marker being typed (no space after it yet) shows as typed.
          if (!spaced(to)) {
            mark(from, to, 'cm-md-mark')
            return
          }
          let label = '•'
          if (list.name === 'OrderedList') {
            const items = list.getChildren('ListItem')
            const firstMark = items[0]?.getChild('ListMark')
            const first = firstMark ? Number.parseInt(doc.sliceString(firstMark.from, firstMark.to), 10) : 1
            label = `${(Number.isNaN(first) ? 1 : first) + items.findIndex((i) => i.from === item.from)}.`
          }
          const end = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to
          out.push({ kind: 'listMark', from: start, to: end, label, depth })
          return
        }
        case 'Paragraph': {
          // The item's text on its later lines lines up with its first line, as in a rendered list item.
          const item = node.parent
          const list = item?.parent
          if (item?.name !== 'ListItem' || !list || !LIST.has(list.name)) return
          const depth = listDepth(list)
          const markLine = doc.lineAt(item.from).number
          for (let n = doc.lineAt(from).number, last = doc.lineAt(to).number; n <= last; n++) {
            if (n === markLine) continue
            const l = doc.line(n)
            line(l.from, 'cm-md-li cm-md-liCont', { style: `--md-depth: ${depth}` })
            hide(l.from, spacesAfter(l.from))
          }
          return
        }
        case 'TaskMarker': {
          const text = doc.sliceString(to, doc.lineAt(to).to).trim()
          // The space after the box goes with it: the caret never lands between the two.
          const end = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to
          out.push({ kind: 'task', from, to: end, checked: /x/i.test(doc.sliceString(from, to)), text })
          return
        }
        case 'HorizontalRule':
          // The line is as tall as the rule: the blank lines around it make the gap, as the rule's margins do.
          line(from, 'cm-md-ruleLine')
          out.push({ kind: 'rule', from, to })
          return
        case 'FencedCode':
        case 'CodeBlock': {
          verbatim.push([from, to])
          const first = doc.lineAt(from)
          const last = doc.lineAt(to)
          const fenced = node.name === 'FencedCode'
          const closed = fenced && node.getChildren('CodeMark').length > 1 && last.number > first.number
          for (let n = first.number; n <= last.number; n++) {
            const cls = ['cm-md-pre']
            if (n === first.number) cls.push('cm-md-preTop')
            if (n === last.number) cls.push('cm-md-preBottom')
            line(doc.line(n).from, cls.join(' '))
          }
          if (!fenced) {
            line(first.from, 'cm-md-prePadTop')
            line(last.from, 'cm-md-prePadBottom')
          } else if (touches(first.from, last.to)) {
            mark(first.from, first.to, 'cm-md-mark')
            if (closed) mark(last.from, last.to, 'cm-md-mark')
            if (!closed) line(last.from, 'cm-md-prePadBottom')
          } else {
            // The fences fold into the block's padding.
            hide(first.from, first.to)
            line(first.from, 'cm-md-fence')
            if (closed) {
              hide(last.from, last.to)
              line(last.from, 'cm-md-fence')
            } else line(last.from, 'cm-md-prePadBottom')
          }
          return false
        }
        case 'Table':
          // Drawn whole by `planBlocks`; nested in a list or a quote, its lines read as source.
          if (node.parent?.name === 'Document') return false
          lines(from, to, 'cm-md-tableSource')
          return
        default:
          return
      }
    },
  })

  // The space between blocks: a blank line stands for the renderer's margin; blocks that touch get it as padding.
  let block = tree.topNode.childAfter(start)
  let previousLast = block?.prevSibling ? doc.lineAt(block.prevSibling.to).number : 0
  for (; block && block.from <= end; block = block.nextSibling) {
    const first = doc.lineAt(block.from)
    const before = first.number - 1
    const blankBefore = before > 0 && doc.line(before).text.trim() === ''
    if (/Heading/.test(block.name)) {
      if (!blankBefore) line(first.from, 'cm-md-gap')
    } else if (previousLast > 0 && previousLast === before) line(first.from, 'cm-md-gap')
    previousLast = doc.lineAt(block.to).number
  }
  const inVerbatim = (from: number, to: number) => verbatim.some(([a, b]) => from < b && to > a)
  for (let n = doc.lineAt(start).number, last = doc.lineAt(end).number; n <= last; n++) {
    const l = doc.line(n)
    if (l.text.trim() === '' && !inVerbatim(l.from, l.to + 1) && !touches(l.from, l.to)) line(l.from, 'cm-md-blank')
  }

  if (options.cloze ?? true) {
    for (const c of clozeSpans(doc.sliceString(start, end))) {
      const from = start + c.from
      const to = start + c.to
      if (inVerbatim(from, to)) continue
      mark(start + c.answerFrom, start + c.answerTo, 'cm-md-cloze')
      const active = touches(from, to)
      syntax(from, start + c.answerFrom, active)
      syntax(start + c.answerTo, to, active)
    }
  }

  const main = state.selection.main
  if (focused && state.selection.ranges.length === 1 && main.empty && main.head >= start && main.head <= end) {
    for (const p of pendingEmphasis(state, main.head)) mark(p.from, p.to, p.cls)
  }
  return out
}

/**
 * The blocks drawn in place of their lines (tables and `$$…$$` formulas at the top level, photos alone on their
 * line) and every photo of the text. Few, so the whole text is read: they decide the text's height. Always drawn:
 * a formula or a table is edited in its own field, never as source in the text.
 */
export function planBlocks(state: EditorState): LiveItem[] {
  const { doc } = state
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state)
  const out: LiveItem[] = []
  for (let block = tree.topNode.firstChild; block; block = block.nextSibling) {
    if (block.name !== 'Table' && block.name !== 'BlockMath') continue
    const first = doc.lineAt(block.from)
    const last = doc.lineAt(block.to)
    if (block.name === 'Table') {
      out.push({ kind: 'table', from: first.from, to: last.to, source: doc.sliceString(first.from, last.to) })
    } else {
      out.push({
        kind: 'math',
        from: first.from,
        to: last.to,
        source: doc.sliceString(block.from, block.to),
        block: true,
      })
    }
  }
  for (const m of doc.toString().matchAll(PHOTO)) {
    const from = m.index
    const to = from + m[0].length
    let code = false
    for (let n: SyntaxNode | null = tree.resolveInner(from, 1); n; n = n.parent) if (VERBATIM.has(n.name)) code = true
    if (code) continue
    const l = doc.lineAt(from)
    out.push({
      kind: 'photo',
      from,
      to,
      sha: m[2] ?? '',
      alt: m[1] ?? '',
      lineFrom: l.from,
      lineTo: l.to,
      alone: l.text.trim() === m[0],
    })
  }
  return out
}

/**
 * Emphasis being typed: an opening `**`, `*`, `_` or `~~` before the caret on its line that nothing closes yet
 * styles the rest of the line at once, so bold starts as soon as `**` is typed. Only an opener that starts a word
 * (at the line's start or after a space) counts: `2*3` or `f(*args)` stay plain, as the renderer leaves them.
 */
export function pendingEmphasis(state: EditorState, head: number): { from: number; to: number; cls: string }[] {
  const { doc } = state
  const tree = syntaxTree(state)
  const l = doc.lineAt(head)
  const before = doc.sliceString(l.from, head)
  const out: { from: number; to: number; cls: string }[] = []
  for (const m of before.matchAll(/\*+|_+|~~/g)) {
    const run = m[0]
    const from = l.from + m.index
    const end = from + run.length
    const next = doc.sliceString(end, end + 1)
    if (end < head && (next === '' || /\s/.test(next))) continue
    if (m.index > 0 && !/\s/.test(before[m.index - 1] ?? '')) continue
    let inside = false
    for (let n: SyntaxNode | null = tree.resolveInner(from, 1); n; n = n.parent) {
      if (NOT_PENDING.has(n.name)) inside = true
    }
    if (inside) continue
    if (run === '~~') out.push({ from: end, to: l.to, cls: 'cm-md-strike' })
    else {
      if (run.length !== 2) out.push({ from: end, to: l.to, cls: 'cm-md-em' })
      if (run.length >= 2) out.push({ from: end, to: l.to, cls: 'cm-md-strong' })
    }
  }
  return out
}

/**
 * Where a table's cell starts in its source: `row` 0 is the header, then the body rows (the delimiter line
 * skipped); `col` counts the cells of that row. Past the last cell: its line's end.
 */
export function tableCellOffset(source: string, row: number, col: number): number {
  const rows = source.split('\n')
  const index = Math.min(row === 0 ? 0 : row + 1, rows.length - 1)
  let offset = 0
  for (let i = 0; i < index; i++) offset += (rows[i] ?? '').length + 1
  const text = rows[index] ?? ''
  let at = 0
  while (at < text.length && SPACE.test(text.charAt(at))) at++
  if (text.charAt(at) === '|') at++
  const starts = [at]
  for (let i = at; i < text.length; i++) {
    const c = text.charAt(i)
    if (c === '\\') i++
    else if (c === '|' && text.slice(i + 1).trim() !== '') starts.push(i + 1)
  }
  if (col >= starts.length) return offset + text.trimEnd().length
  let cell = starts[col] ?? at
  while (cell < text.length && SPACE.test(text.charAt(cell))) cell++
  return offset + cell
}

const MARKERS = /[*_~`[\]$]/

/**
 * The word a double click means at `pos`: the word there, or across the Markdown markers next to it (`**`, `[`…),
 * which come back in sight between the two clicks.
 */
export function wordNear(state: EditorState, pos: number): Span | null {
  const direct = state.wordAt(pos)
  if (direct) return { from: direct.from, to: direct.to }
  const { doc } = state
  for (let p = pos; p < Math.min(doc.length, pos + 3) && MARKERS.test(doc.sliceString(p, p + 1)); ) {
    p++
    const w = state.wordAt(p)
    if (w) return { from: w.from, to: w.to }
  }
  for (let p = pos; p > Math.max(0, pos - 3) && MARKERS.test(doc.sliceString(p - 1, p)); ) {
    p--
    const w = state.wordAt(p)
    if (w) return { from: w.from, to: w.to }
  }
  return null
}

/** Hidden syntax that starts a line: indentation, a heading's `#`, a quote's `>`. */
const BLOCK_PREFIX = /^(?:\s+|#{1,6}\s*|>\s?)$/

/**
 * The syntax hidden at the start of `pos`'s line (a heading's `## `, `> `, a list marker, a task's box, a list item's
 * indentation): the caret never sits inside it, so what is typed goes into the heading, the quote or the item.
 */
export function hiddenPrefix(state: EditorState, pos: number): Span | null {
  const { doc } = state
  const line = doc.lineAt(pos)
  const items = planInline(state, false, { within: { from: line.from, to: line.to }, cloze: false })
  let end = line.from
  for (;;) {
    const next = items.find(
      (i) =>
        (i.kind === 'listMark' ||
          i.kind === 'task' ||
          (i.kind === 'hide' && BLOCK_PREFIX.test(doc.sliceString(i.from, i.to)))) &&
        i.from <= end &&
        i.to > end &&
        i.to <= line.to,
    )
    if (!next || next.kind === 'line') break
    end = next.to
  }
  return end > line.from ? { from: line.from, to: end } : null
}

/** The innermost node named one of `names` around `pos` (either side of it), or null. */
function around(state: EditorState, pos: number, names: ReadonlySet<string>): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state)
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) if (names.has(n.name)) return n
  }
  return null
}

/** A link in the text: the whole `[text](url)`, where its text sits, and its address. */
export interface LinkSpan extends Span {
  textFrom: number
  textTo: number
  url: string
}

const LINK = new Set(['Link'])

export function linkAt(state: EditorState, pos: number): LinkSpan | null {
  const node = around(state, pos, LINK)
  if (!node) return null
  const [open, close] = node.getChildren('LinkMark')
  if (!open || !close) return null
  const url = node.getChild('URL')
  return {
    from: node.from,
    to: node.to,
    textFrom: open.to,
    textTo: close.from,
    url: url ? state.doc.sliceString(url.from, url.to) : '',
  }
}

/** A formula in the text: the whole `$…$` or `$$…$$`, and its LaTeX. */
export interface MathSpan extends Span {
  block: boolean
  latex: string
}

const MATH = new Set(['InlineMath', 'BlockMath'])

export function mathAt(state: EditorState, pos: number): MathSpan | null {
  const node = around(state, pos, MATH)
  if (!node) return null
  const block = node.name === 'BlockMath'
  const marks = node.getChildren(block ? 'BlockMathMark' : 'InlineMathMark')
  const first = marks[0]
  const last = marks.at(-1)
  const inner =
    first && last && last.from > first.from
      ? state.doc.sliceString(first.to, last.from)
      : state.doc.sliceString(node.from, node.to)
  return { from: node.from, to: node.to, block, latex: block ? inner.replace(/^\n|\n$/g, '') : inner }
}

/** A table in the text: its lines, whole. */
export interface TableSpan extends Span {
  source: string
}

const TABLE = new Set(['Table'])

export function tableAt(state: EditorState, pos: number): TableSpan | null {
  const node = around(state, pos, TABLE)
  if (!node) return null
  const from = state.doc.lineAt(node.from).from
  const to = state.doc.lineAt(node.to).to
  return { from, to, source: state.doc.sliceString(from, to) }
}
