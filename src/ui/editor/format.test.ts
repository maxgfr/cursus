import { describe, expect, test } from 'bun:test'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { type Marker, prefixLines, toggleMarker, toggleTask } from './format.ts'

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

  test('at a caret: a pair, then taken back', () => {
    expect(mark('ab', 1, 1, '**')).toBe('a**|**b')
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
