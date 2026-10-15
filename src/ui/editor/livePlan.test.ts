import { describe, expect, test } from 'bun:test'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import {
  type LiveItem,
  liveMarkdown,
  pendingEmphasis,
  planBlocks,
  planInline,
  planLive,
  tableCellOffset,
  wordNear,
} from './livePlan.ts'

const SHA = 'a'.repeat(64)

function state(doc: string, caret?: number | [number, number]) {
  const selection =
    caret === undefined
      ? undefined
      : typeof caret === 'number'
        ? EditorSelection.cursor(caret)
        : EditorSelection.range(caret[0], caret[1])
  const s = EditorState.create({ doc, extensions: [liveMarkdown()], ...(selection ? { selection } : {}) })
  ensureSyntaxTree(s, s.doc.length, 5000)
  return s
}

/** The plan, focused on the given caret (or unfocused when there is none). */
function plan(doc: string, caret?: number | [number, number]): LiveItem[] {
  return planLive(state(doc, caret), caret !== undefined)
}

const hidden = (items: LiveItem[], doc: string) =>
  items.flatMap((i) => (i.kind === 'hide' ? [doc.slice(i.from, i.to)] : []))
const marked = (items: LiveItem[], doc: string, cls: string) =>
  items.flatMap((i) => (i.kind === 'mark' && i.cls === cls ? [doc.slice(i.from, i.to)] : []))
/** Each line class as [the line's text, the class]. */
const lineClasses = (items: LiveItem[], doc: string): [string, string][] =>
  items.flatMap((i): [string, string][] => {
    if (i.kind !== 'line') return []
    const end = doc.indexOf('\n', i.at)
    return [[doc.slice(i.at, end < 0 ? undefined : end), i.cls]]
  })

describe('inline syntax', () => {
  const doc = 'Some **bold**, *it*, ~~gone~~ and `code`.'

  test('caret elsewhere: styled, markers hidden', () => {
    const items = plan(doc, 0)
    expect(marked(items, doc, 'cm-md-strong')).toEqual(['**bold**'])
    expect(marked(items, doc, 'cm-md-em')).toEqual(['*it*'])
    expect(marked(items, doc, 'cm-md-strike')).toEqual(['~~gone~~'])
    expect(marked(items, doc, 'cm-md-code')).toEqual(['`code`'])
    expect(hidden(items, doc)).toEqual(['**', '**', '*', '*', '~~', '~~', '`', '`'])
  })

  test('caret inside one element: only its markers come back, dimmed', () => {
    const at = doc.indexOf('bold') + 2
    const items = plan(doc, at)
    expect(marked(items, doc, 'cm-md-mark')).toEqual(['**', '**'])
    expect(hidden(items, doc)).toEqual(['*', '*', '~~', '~~', '`', '`'])
  })

  test('caret right after the closing marker still counts as inside', () => {
    const items = plan(doc, doc.indexOf('**,') + 2)
    expect(marked(items, doc, 'cm-md-mark')).toContain('**')
  })

  test('a selection across elements reveals them all', () => {
    expect(hidden(plan(doc, [0, doc.length]), doc)).toEqual([])
  })

  test('unfocused: everything drawn, wherever the selection is', () => {
    const s = state(doc, doc.indexOf('bold'))
    expect(hidden(planLive(s, false), doc)).toHaveLength(8)
  })

  test('a link shows its text, its brackets and URL hidden', () => {
    const d = 'See [the docs](https://example.com) now'
    const items = plan(d)
    expect(marked(items, d, 'cm-md-link')).toEqual(['the docs'])
    expect(hidden(items, d)).toEqual(['[', '](https://example.com)'])
  })

  test('an escape hides its backslash', () => {
    const d = 'a \\*star\\* b'
    expect(hidden(plan(d), d)).toEqual(['\\', '\\'])
  })
})

describe('typing emphasis', () => {
  test('an opening ** styles the rest of the line at once', () => {
    const d = 'Hello **wor'
    expect(pendingEmphasis(state(d), d.length)).toEqual([{ from: 8, to: 11, cls: 'cm-md-strong' }])
    expect(marked(plan(d, d.length), d, 'cm-md-strong')).toEqual(['wor'])
  })

  test('single star, underscore, triple star, tilde', () => {
    expect(pendingEmphasis(state('a *b'), 4).map((p) => p.cls)).toEqual(['cm-md-em'])
    expect(pendingEmphasis(state('a _b'), 4).map((p) => p.cls)).toEqual(['cm-md-em'])
    expect(pendingEmphasis(state('a ***b'), 6).map((p) => p.cls)).toEqual(['cm-md-em', 'cm-md-strong'])
    expect(pendingEmphasis(state('a ~~b'), 5).map((p) => p.cls)).toEqual(['cm-md-strike'])
  })

  test('not an opener: closed pairs, a star before a space, list markers, intraword underscores, code', () => {
    expect(pendingEmphasis(state('**done** x'), 10)).toEqual([])
    expect(pendingEmphasis(state('2 * 3'), 5)).toEqual([])
    expect(pendingEmphasis(state('* item'), 6)).toEqual([])
    expect(pendingEmphasis(state('snake_case'), 10)).toEqual([])
    expect(pendingEmphasis(state('`a **b` c'), 9)).toEqual([])
    expect(pendingEmphasis(state('$a*b$ c'), 7)).toEqual([])
  })

  test('the caret right after the opener: nothing to style yet, but no error', () => {
    const d = 'x **'
    expect(pendingEmphasis(state(d), d.length)).toEqual([{ from: 4, to: 4, cls: 'cm-md-strong' }])
  })
})

describe('blocks', () => {
  test('headings: sized line, nested under the screen title, # hidden off the line', () => {
    const d = '# Title\n\n## Part\ntext'
    const items = plan(d, d.length)
    expect(lineClasses(items, d)).toContainEqual(['# Title', 'cm-md-h cm-md-h1'])
    expect(lineClasses(items, d)).toContainEqual(['## Part', 'cm-md-h cm-md-h2'])
    const h1 = items.find((i) => i.kind === 'line' && i.cls === 'cm-md-h cm-md-h1')
    expect(h1?.kind === 'line' ? h1.attrs : undefined).toEqual({ role: 'heading', 'aria-level': '2' })
    expect(hidden(items, d)).toEqual(['# ', '## '])
    expect(hidden(plan(d, 3), d)).toEqual(['## '])
  })

  test('bullet and numbered lists: markers drawn, numbers counted as the renderer does', () => {
    const d = '- one\n- two\n  - deep\n\n1. a\n1. b'
    const items = plan(d)
    const marks = items.flatMap((i) => (i.kind === 'listMark' ? [[d.slice(i.from, i.to), i.label, i.depth]] : []))
    expect(marks).toEqual([
      ['- ', '•', 1],
      ['- ', '•', 1],
      ['  - ', '•', 2],
      ['1. ', '1.', 1],
      ['1. ', '2.', 1],
    ])
  })

  test('a list marker comes back when the caret is on it, not when it starts the text', () => {
    const d = '- one'
    expect(plan(d, 0).filter((i) => i.kind === 'listMark')).toEqual([])
    expect(plan(d, 2).filter((i) => i.kind === 'listMark')).toHaveLength(1)
  })

  test('task items become checkboxes', () => {
    const d = '- [ ] todo\n- [x] done'
    const tasks = plan(d).flatMap((i) => (i.kind === 'task' ? [i.checked] : []))
    expect(tasks).toEqual([false, true])
  })

  test('blockquote lines, > hidden off the line', () => {
    const d = '> quoted\n> more'
    const items = plan(d, d.length)
    expect(lineClasses(items, d).filter(([, c]) => c === 'cm-md-quote')).toHaveLength(2)
    expect(hidden(items, d)).toEqual(['> '])
  })

  test('horizontal rule drawn off its line', () => {
    expect(plan('a\n\n---\n\nb').filter((i) => i.kind === 'rule')).toHaveLength(1)
    expect(plan('a\n\n---\n\nb', 4).filter((i) => i.kind === 'rule')).toHaveLength(0)
  })

  test('fenced code: one block of lines, fences folded away when the caret is out', () => {
    const d = 'a\n\n```js\nlet x = **1**\n```\n\nb'
    const items = plan(d, 0)
    expect(lineClasses(items, d).filter(([, c]) => c.startsWith('cm-md-pre'))).toHaveLength(3)
    expect(hidden(items, d)).toEqual(['```js', '```'])
    // Nothing inside code is read as Markdown.
    expect(marked(items, d, 'cm-md-strong')).toEqual([])
    expect(hidden(plan(d, d.indexOf('let')), d)).toEqual([])
  })

  test('a table is drawn whole off it, shown as source on it', () => {
    const d = 'a\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\nb'
    const table = plan(d, 0).find((i) => i.kind === 'table')
    expect(table?.kind === 'table' ? table.source : '').toBe('| x | y |\n| --- | --- |\n| 1 | 2 |')
    expect(plan(d, d.indexOf('1 |')).some((i) => i.kind === 'table')).toBe(false)
  })

  test('blank lines between blocks stand for the gap; touching blocks get it as padding', () => {
    const d = '# T\ntext\n\nmore'
    const classes = lineClasses(plan(d), d)
    expect(classes).toContainEqual(['', 'cm-md-blank'])
    expect(classes).toContainEqual(['text', 'cm-md-gap'])
    expect(classes).toContainEqual(['# T', 'cm-md-gap'])
    expect(classes).not.toContainEqual(['more', 'cm-md-gap'])
  })
})

describe('maths', () => {
  test('inline maths drawn off the caret, source on it', () => {
    const d = 'Area $\\pi r^2$ here'
    const math = plan(d, 0).find((i) => i.kind === 'math')
    expect(math).toEqual({ kind: 'math', from: 5, to: 14, source: '$\\pi r^2$', block: false })
    const on = plan(d, 8)
    expect(on.some((i) => i.kind === 'math')).toBe(false)
    expect(marked(on, d, 'cm-md-mathSource')).toEqual(['$\\pi r^2$'])
  })

  test('as the renderer: no maths for $$ inline, a price, or emphasis inside a formula', () => {
    expect(plan('costs $5 and $6').some((i) => i.kind === 'math')).toBe(false)
    const d = 'x $a*b*c$ y'
    const items = plan(d)
    expect(items.some((i) => i.kind === 'math')).toBe(true)
    expect(marked(items, d, 'cm-md-em')).toEqual([])
  })

  test('block maths over whole lines, on one line or several', () => {
    const one = 'a\n\n$$x^2$$\n\nb'
    expect(plan(one, 0).find((i) => i.kind === 'math')).toEqual({
      kind: 'math',
      from: 3,
      to: 10,
      source: '$$x^2$$',
      block: true,
    })
    const many = 'a\n$$\n\\frac{1}{2}\n$$\nb'
    const block = plan(many, 0).find((i) => i.kind === 'math')
    expect(block).toEqual({ kind: 'math', from: 2, to: 19, source: '$$\n\\frac{1}{2}\n$$', block: true })
  })

  test('an unclosed $$ stays a paragraph', () => {
    expect(plan('$$\nx\n\ny').some((i) => i.kind === 'math')).toBe(false)
  })

  test('block maths with the caret in it: source lines', () => {
    const d = '$$\nx\n$$'
    const items = plan(d, 3)
    expect(items.some((i) => i.kind === 'math')).toBe(false)
    expect(lineClasses(items, d).filter(([, c]) => c === 'cm-md-mathLine')).toHaveLength(3)
  })
})

describe('cloze and photos', () => {
  test('a cloze shows its answer marked, its syntax and hint hidden', () => {
    const d = 'The {{c1::Seine::river}} flows'
    const items = plan(d)
    expect(marked(items, d, 'cm-md-cloze')).toEqual(['Seine'])
    expect(hidden(items, d)).toEqual(['{{c1::', '::river}}'])
    expect(hidden(plan(d, 12), d)).toEqual([])
  })

  test('cloze syntax inside code stays code', () => {
    const d = '`{{c1::x}}`'
    expect(marked(plan(d), d, 'cm-md-cloze')).toEqual([])
  })

  test('a photo alone on its line, then beside text, then with the caret on it', () => {
    const ref = `![Skeleton](cursus-blob:${SHA})`
    const d = `${ref}\n\nSee ${ref}`
    const photos = plan(d, d.length).flatMap((i) => (i.kind === 'photo' ? [[i.alt, i.sha, i.alone, i.active]] : []))
    expect(photos).toEqual([
      ['Skeleton', SHA, true, false],
      ['Skeleton', SHA, false, true],
    ])
  })
})

describe('what the renderer prints, the editor draws', () => {
  test('outside a cloze card, cloze syntax is plain text', () => {
    const d = 'The {{c1::Seine::river}} flows'
    const items = planLive(state(d), false, { cloze: false })
    expect(marked(items, d, 'cm-md-cloze')).toEqual([])
    expect(hidden(items, d)).toEqual([])
  })

  test('typed stars that cannot open emphasis stay plain, a link included', () => {
    expect(pendingEmphasis(state('2*3=6'), 5)).toEqual([])
    expect(pendingEmphasis(state('f(*args)'), 8)).toEqual([])
    expect(pendingEmphasis(state('see [**link](u)'), 15)).toEqual([])
    expect(pendingEmphasis(state('see [**li'), 9)).toEqual([])
    // Still at once for a word being typed.
    expect(pendingEmphasis(state('see **li'), 8)).toEqual([{ from: 6, to: 8, cls: 'cm-md-strong' }])
  })

  test("a list item's later lines line up with its text, their indentation hidden", () => {
    const d = '- one\n  two continues\n- three\n  - deep\n    more'
    const items = plan(d)
    expect(lineClasses(items, d).filter(([, c]) => c.includes('cm-md-liCont'))).toEqual([
      ['  two continues', 'cm-md-li cm-md-liCont'],
      ['    more', 'cm-md-li cm-md-liCont'],
    ])
    const depths = items.flatMap((i) => (i.kind === 'line' && i.cls.includes('liCont') ? [i.attrs?.style] : []))
    expect(depths).toEqual(['--md-depth: 1', '--md-depth: 2'])
    expect(hidden(items, d)).toEqual(['  ', '    '])
    // A lazy line (no indentation) lines up too.
    expect(lineClasses(plan('- one\ntwo'), '- one\ntwo')).toContainEqual(['two', 'cm-md-li cm-md-liCont'])
  })

  test("a drawn rule's line is only the rule", () => {
    const d = 'a\n\n---\n\nb'
    expect(lineClasses(plan(d), d)).toContainEqual(['---', 'cm-md-ruleLine'])
    expect(lineClasses(plan(d, 4), d)).not.toContainEqual(['---', 'cm-md-ruleLine'])
  })

  test('a task checkbox knows its task', () => {
    const d = '- [ ] buy milk\n- [x] done it'
    expect(plan(d).flatMap((i) => (i.kind === 'task' ? [i.text] : []))).toEqual(['buy milk', 'done it'])
  })
})

describe('reveal and windows', () => {
  test('the reveal can differ from the selection (held while a pointer selects)', () => {
    const d = 'Some **bold** word'
    const s = state(d, d.indexOf('bold') + 1)
    expect(hidden(planLive(s, true), d)).toEqual([])
    expect(hidden(planLive(s, true, { reveal: [] }), d)).toEqual(['**', '**'])
  })

  test('drawn blocks come from planBlocks only; their lines are left alone by planInline', () => {
    const d = 'a\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n$$\nx^2\n$$\n\nb'
    const s = state(d, 0)
    expect(planBlocks(s, true).map((i) => i.kind)).toEqual(['table', 'math'])
    const inline = planInline(s, true)
    expect(inline.some((i) => i.kind === 'table' || (i.kind === 'math' && i.block))).toBe(false)
    expect(lineClasses(inline, d).some(([, c]) => c === 'cm-md-tableSource' || c === 'cm-md-mathLine')).toBe(false)
  })

  test('a window plans only the blocks over it, as the whole text would', () => {
    const paragraphs = Array.from({ length: 2000 }, (_, i) => `Line ${i} has **bold** and *it* $x$`)
    const d = paragraphs.join('\n\n')
    const s = state(d, 0)
    const at = d.indexOf('Line 1000 ')
    const end = at + (paragraphs[1000] ?? '').length
    const part = planInline(s, false, { within: { from: at + 3, to: at + 10 } })
    const key = (i: LiveItem) => JSON.stringify(i)
    const whole = planInline(s, false).map(key)
    const inBlock = planInline(s, false)
      .filter((i) => (i.kind === 'line' ? i.at : i.from) >= at && (i.kind === 'line' ? i.at : i.to) <= end)
      .map(key)
    expect(part.map(key).every((k) => whole.includes(k))).toBe(true)
    expect(inBlock.every((k) => part.map(key).includes(k))).toBe(true)
    expect(part.length).toBeLessThan(20)
  })
})

describe('tables and double clicks', () => {
  test("a cell's place in the table source", () => {
    const src = '| a | b |\n|---|---|\n| 1 | 2 |'
    const at = (row: number, col: number) => src.charAt(tableCellOffset(src, row, col))
    expect([at(0, 0), at(0, 1), at(1, 0), at(1, 1)]).toEqual(['a', 'b', '1', '2'])
    const bare = 'a | b\n--|--\nx \\| y | z'
    const bareAt = (row: number, col: number) => bare.charAt(tableCellOffset(bare, row, col))
    expect([bareAt(0, 0), bareAt(0, 1), bareAt(1, 0), bareAt(1, 1)]).toEqual(['a', 'b', 'x', 'z'])
    // Past the last cell: the end of its row.
    expect(tableCellOffset(src, 1, 5)).toBe(src.length)
  })

  test('the word a double click means, across the markers next to it', () => {
    const d = 'Use **as** a verb, `fn` and [go](https://e.com).'
    const word = (pos: number) => {
      const w = wordNear(state(d), pos)
      return w ? d.slice(w.from, w.to) : null
    }
    expect(word(d.indexOf('as'))).toBe('as')
    expect(word(d.indexOf('**as'))).toBe('as')
    expect(word(d.indexOf('`fn'))).toBe('fn')
    expect(word(d.indexOf('[go'))).toBe('go')
    expect(word(d.indexOf(' a verb') + 1)).toBe('a')
  })
})
