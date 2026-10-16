import { describe, expect, test } from 'bun:test'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import {
  activeFormats,
  inputRule,
  leaveEmptyItem,
  linkAddress,
  linkMarkdown,
  type Marker,
  mathMarkdown,
  parseTable,
  pendingFormat,
  prefixLines,
  setHeading,
  tableMarkdown,
  toggleList,
  toggleMarker,
  toggleQuote,
  toggleTask,
  typePending,
  unformatLine,
} from './format.ts'
import { liveMarkdown } from './livePlan.ts'

function state(doc: string, anchor: number, head = anchor) {
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
}

/** The text after the command, the selection marked `[` `]` (or `|` for a caret). */
function after(s: EditorState, spec: TransactionSpec | null): string {
  if (spec === null) return 'null'
  const next = s.update(spec).state
  const { from, to } = next.selection.main
  const doc = next.doc.toString()
  return from === to
    ? `${doc.slice(0, from)}|${doc.slice(from)}`
    : `${doc.slice(0, from)}[${doc.slice(from, to)}]${doc.slice(to)}`
}

const mark = (doc: string, from: number, to: number, m: Marker) =>
  after(state(doc, from, to), toggleMarker(state(doc, from, to), m))

describe('heading and list buttons', () => {
  test('on an empty line, what is typed next goes after the prefix', () => {
    const s = state('', 0)
    expect(after(s, prefixLines(s, '## '))).toBe('## |')
    const typed = s.update(prefixLines(s, '## ')).state
    const withTitle = typed.update(typed.replaceSelection('Title')).state
    expect(withTitle.doc.toString()).toBe('## Title')
  })

  test('at the start of a line with text, and off again', () => {
    const s = state('one\ntwo', 4)
    expect(after(s, prefixLines(s, '- '))).toBe('one\n- |two')
    const on = state('- two', 2)
    expect(after(on, prefixLines(on, '- '))).toBe('|two')
  })
})

describe('bold, italic, code and maths toggle', () => {
  test('on a selection: wrapped, then unwrapped', () => {
    expect(mark('hi', 0, 2, '**')).toBe('**[hi]**')
    expect(mark('**hi**', 2, 4, '**')).toBe('[hi]')
    expect(mark('*hi*', 1, 3, '*')).toBe('[hi]')
    expect(mark('`hi`', 1, 3, '`')).toBe('[hi]')
    expect(mark('$x$', 1, 2, '$')).toBe('[x]')
  })

  test('the markers inside the selection count too', () => {
    expect(mark('**hi**', 0, 6, '**')).toBe('[hi]')
    expect(mark('*hi*', 0, 4, '*')).toBe('[hi]')
  })

  test('italic on bold makes both, and each comes off on its own', () => {
    expect(mark('**hi**', 2, 4, '*')).toBe('***[hi]***')
    expect(mark('***hi***', 3, 5, '*')).toBe('**[hi]**')
    expect(mark('***hi***', 3, 5, '**')).toBe('*[hi]*')
    expect(mark('*hi*', 1, 3, '**')).toBe('***[hi]***')
  })

  test('at a caret: nothing is written (the format waits for what is typed); an empty pair is taken back', () => {
    // A behaviour change: the caret used to get an empty pair (`a**|**b`), read as a rule or a code fence on an
    // empty line, and shown as typed until something was written in it.
    expect(mark('ab', 1, 1, '**')).toBe('a|b')
    expect(mark('a****b', 3, 3, '**')).toBe('a|b')
  })
})

describe('tasks', () => {
  test('the tasks on the selected lines are ticked or unticked; other lines are left', () => {
    const doc = '- [ ] one\n- [x] two\nplain\n1. [ ] three'
    const all = EditorState.create({ doc, selection: EditorSelection.single(0, doc.length) })
    expect(all.update(toggleTask(all) ?? {}).state.doc.toString()).toBe('- [x] one\n- [ ] two\nplain\n1. [x] three')
    expect(toggleTask(state(doc, doc.indexOf('plain')))).toBeNull()
  })
})

/** A state with Markdown parsed, for what reads the syntax tree. */
function parsed(doc: string, anchor: number, head = anchor) {
  const s = EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [liveMarkdown()] })
  ensureSyntaxTree(s, s.doc.length, 5000)
  return s
}

describe('the toolbar on lines', () => {
  test('strikethrough toggles like the other inline formats', () => {
    expect(mark('hi', 0, 2, '~~')).toBe('~~[hi]~~')
    expect(mark('~~hi~~', 2, 4, '~~')).toBe('[hi]')
  })

  test('headings: set, changed to another level, then back to text', () => {
    const s = state('Title', 2)
    expect(after(s, setHeading(s, 1))).toBe('# Ti|tle')
    const h1 = state('# Title', 4)
    expect(after(h1, setHeading(h1, 2))).toBe('## Ti|tle')
    const h2 = state('## Title', 5)
    expect(after(h2, setHeading(h2, 2))).toBe('Ti|tle')
  })

  test('lists: bulleted, numbered in order, tasks; switched from one kind to another, then off', () => {
    const doc = 'one\ntwo\nthree'
    const all = state(doc, 0, doc.length)
    const run = (s: EditorState, kind: 'bullet' | 'numbered' | 'task') => s.update(toggleList(s, kind)).state
    expect(run(all, 'bullet').doc.toString()).toBe('- one\n- two\n- three')
    expect(run(all, 'numbered').doc.toString()).toBe('1. one\n2. two\n3. three')
    const tasks = run(all, 'task')
    expect(tasks.doc.toString()).toBe('- [ ] one\n- [ ] two\n- [ ] three')
    expect(run(tasks, 'numbered').doc.toString()).toBe('1. one\n2. two\n3. three')
    expect(run(tasks, 'task').doc.toString()).toBe(doc)
    const nested = state('  - deep', 5)
    expect(after(nested, toggleList(nested, 'numbered'))).toBe('  1. d|eep')
  })

  test('quote on, then off', () => {
    const s = state('a\nb', 0, 3)
    const on = s.update(toggleQuote(s)).state
    expect(on.doc.toString()).toBe('> a\n> b')
    expect(on.update(toggleQuote(on)).state.doc.toString()).toBe('a\nb')
  })
})

describe('typing, word-processor style', () => {
  test('[] or [ ] then a space at a line start makes a task; elsewhere it is typed as is', () => {
    const typed = (doc: string, pos = doc.length) => {
      const s = state(doc, pos)
      return after(s, inputRule(s, pos, pos, ' '))
    }
    expect(typed('[]')).toBe('- [ ] |')
    expect(typed('[ ]')).toBe('- [ ] |')
    expect(typed('  * []')).toBe('  * [ ] |')
    expect(typed('1. [ ]')).toBe('1. [ ] |')
    expect(typed('see []')).toBe('null')
    const s = state('[]', 2)
    expect(inputRule(s, 2, 2, 'x')).toBeNull()
  })

  test('Backspace right after a heading, a list marker or a task takes the formatting off', () => {
    const back = (doc: string, pos = doc.length) => {
      const s = state(doc, pos)
      return after(s, unformatLine(s))
    }
    expect(back('## ')).toBe('|')
    expect(back('## Title', 3)).toBe('|Title')
    expect(back('- item', 2)).toBe('|item')
    expect(back('  - deep', 4)).toBe('|deep')
    expect(back('- [ ] todo', 6)).toBe('|todo')
    expect(back('1. one', 3)).toBe('|one')
    // In a quote the list goes first, then the quote.
    expect(back('> - item', 4)).toBe('> |item')
    expect(back('> item', 2)).toBe('|item')
    // Anywhere else Backspace deletes a character, as usual.
    expect(back('## Title', 5)).toBe('null')
    expect(back('plain', 0)).toBe('null')
    expect(back('', 0)).toBe('null')
  })
})

describe('leaving a list', () => {
  test('Enter on an empty item or task leaves the list, a blank line after it; elsewhere Enter is Enter', () => {
    const enter = (doc: string, pos = doc.length) => {
      const s = state(doc, pos)
      return after(s, leaveEmptyItem(s))
    }
    expect(enter('- item\n- ')).toBe('- item\n\n|')
    expect(enter('- [ ] milk\n- [ ] ')).toBe('- [ ] milk\n\n|')
    expect(enter('1. one\n2. ')).toBe('1. one\n\n|')
    expect(enter('- ')).toBe('|')
    expect(enter('> - a\n> - ')).toBe('> - a\n> |')
    expect(enter('- item')).toBe('null')
    expect(enter('- item\n- ', 7)).toBe('null')
  })
})

describe('what the toolbar shows as on', () => {
  test('the formats where the caret is', () => {
    const on = (doc: string, pos: number) => [...activeFormats(parsed(doc, pos))].sort()
    expect(on('**bold** and *it*', 3)).toEqual(['bold'])
    expect(on('**bold** and *it*', 15)).toEqual(['italic'])
    expect(on('## Title', 5)).toEqual(['h2'])
    expect(on('- item', 3)).toEqual(['bullet'])
    expect(on('1. item', 4)).toEqual(['numbered'])
    expect(on('- [ ] todo', 7)).toEqual(['task'])
    expect(on('> quoted **b**', 12)).toEqual(['bold', 'quote'])
    expect(on('see [x](u)', 5)).toEqual(['link'])
    expect(on('a $x$ b', 3)).toEqual(['math'])
    expect(on('| a |\n| - |\n| 1 |', 2)).toEqual(['table'])
    expect(on('plain', 2)).toEqual([])
    // Between an element's markers only: right after bold, or before it, what is typed is plain.
    expect(on('**bold** x', 6)).toEqual(['bold'])
    expect(on('**bold** x', 8)).toEqual([])
    expect(on('x **bold**', 2)).toEqual([])
  })
})

describe('links, formulas and tables as Markdown', () => {
  test('a link: its text escaped, an address with spaces or parentheses in angle brackets', () => {
    expect(linkMarkdown('the docs', 'https://e.com')).toBe('[the docs](https://e.com)')
    expect(linkMarkdown('a [b]', 'https://e.com/x (1)')).toBe('[a \\[b\\]](<https://e.com/x (1)>)')
    expect(linkAddress('https://e.com/<x>')).toBe('<https://e.com/%3Cx%3E>')
    expect(linkAddress('https://e.com/a')).toBe('https://e.com/a')
  })

  test('a formula in a line or on lines of its own', () => {
    expect(mathMarkdown(' x^2 ', false)).toBe('$x^2$')
    expect(mathMarkdown('\\frac{1}{2}', true)).toBe('$$\n\\frac{1}{2}\n$$')
  })

  test('a table read into cells and written back, a | in a cell escaped', () => {
    const source = '| a | b |\n| --- | --- |\n| 1 | x \\| y |'
    const rows = parseTable(source)
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', 'x | y'],
    ])
    expect(tableMarkdown(rows)).toBe(source)
    expect(parseTable('a | b\n--|--\nx')).toEqual([
      ['a', 'b'],
      ['x', ''],
    ])
    expect(tableMarkdown([['h'], ['two\nlines']])).toBe('| h |\n| --- |\n| two lines |')
  })
})

describe('a format at the caret', () => {
  /** A live text: Markdown parsed, formats able to wait at the caret. */
  function live(doc: string, anchor: number, head = anchor) {
    const s = EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [liveMarkdown(), pendingFormat],
    })
    ensureSyntaxTree(s, s.doc.length, 5000)
    return s
  }
  const shown = (s: EditorState) => {
    const { from } = s.selection.main
    const doc = s.doc.toString()
    return `${doc.slice(0, from)}|${doc.slice(from)}`
  }
  const type = (s: EditorState, text: string) => {
    const at = s.selection.main.head
    return s.update(typePending(s, at, at, text) ?? s.replaceSelection(text)).state
  }

  test('waits for what is typed: nothing written until then, then the text in the format, the caret inside', () => {
    const s = live('ab', 1)
    const on = s.update(toggleMarker(s, '**')).state
    expect(on.doc.toString()).toBe('ab')
    expect(on.field(pendingFormat)).toEqual({ pos: 1, markers: ['**'] })
    expect(activeFormats(on).has('bold')).toBe(true)
    const typed = type(on, 'x')
    expect(shown(typed)).toBe('a**x|**b')
    expect(typed.field(pendingFormat)).toBeNull()
    expect(shown(type(typed, 'y'))).toBe('a**xy|**b')
  })

  test('asked twice, nothing waits and nothing was written', () => {
    const s = live('ab', 1)
    const on = s.update(toggleMarker(s, '**')).state
    const off = on.update(toggleMarker(on, '**')).state
    expect(off.doc.toString()).toBe('ab')
    expect(off.field(pendingFormat)).toBeNull()
    expect(activeFormats(off).has('bold')).toBe(false)
  })

  test('white space typed first goes before the markers; two formats wrap the text together', () => {
    const s = live('a', 1)
    const bold = s.update(toggleMarker(s, '**')).state
    const both = bold.update(toggleMarker(bold, '*')).state
    expect([...activeFormats(both)].sort()).toEqual(['bold', 'italic'])
    const spaced = type(both, ' ')
    expect(shown(spaced)).toBe('a |')
    expect(spaced.field(pendingFormat)).toEqual({ pos: 2, markers: ['**', '*'] })
    expect(shown(type(spaced, 'b'))).toBe('a ***b|***')
    expect(shown(type(both, ' c'))).toBe('a ***c|***')
  })

  test('on an empty line: no rule, no code block, never a star in sight', () => {
    for (const marker of ['**', '~~', '`'] as const) {
      const s = live('', 0)
      const on = s.update(toggleMarker(s, marker)).state
      expect(on.doc.toString()).toBe('')
      const typed = type(on, 'Title')
      expect(typed.doc.toString()).toBe(`${marker}Title${marker}`)
    }
  })

  test('the caret moving away drops it; an edit from elsewhere only moves it', () => {
    const s = live('abc', 1)
    const on = s.update(toggleMarker(s, '**')).state
    expect(on.update({ selection: EditorSelection.cursor(3) }).state.field(pendingFormat)).toBeNull()
    expect(on.update({ changes: { from: 0, insert: 'xy' } }).state.field(pendingFormat)).toEqual({
      pos: 3,
      markers: ['**'],
    })
    // Typed elsewhere than where it waits, or several characters over a selection: as typed.
    expect(typePending(on, 2, 2, 'x')).toBeNull()
    expect(typePending(on, 1, 2, 'x')).toBeNull()
    expect(typePending(on, 1, 1, '\n')).toBeNull()
    expect(typePending(s, 1, 1, 'x')).toBeNull()
  })

  test('at the end of bold, a second toggle steps out of it; at its start, before it', () => {
    const d = 'a **bold** b'
    const end = live(d, 8)
    expect(shown(end.update(toggleMarker(end, '**')).state)).toBe('a **bold**| b')
    const start = live(d, 4)
    expect(shown(start.update(toggleMarker(start, '**')).state)).toBe('a |**bold** b')
    const code = live('a `x` b', 4)
    expect(shown(code.update(toggleMarker(code, '`')).state)).toBe('a `x`| b')
    // Italic at the end of bold is not bold's: it waits, to type italic in the bold.
    const italic = end.update(toggleMarker(end, '*')).state
    expect(italic.field(pendingFormat)).toEqual({ pos: 8, markers: ['*'] })
  })

  test('in a pair being typed into, the toggle steps out and tidies it', () => {
    const s = live('**a **', 4)
    expect(shown(s.update(toggleMarker(s, '**')).state)).toBe('**a** |')
  })

  test('inside bold, a waiting bold is off: what is typed comes out of it', () => {
    const s = live('**bold**', 4)
    const off = s.update(toggleMarker(s, '**')).state
    expect(activeFormats(off).has('bold')).toBe(false)
    expect(type(off, 'x').doc.toString()).toBe('**bo**x**ld**')
  })
})
