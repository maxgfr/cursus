import { describe, expect, test } from 'bun:test'
import { applyStep, planWrite } from './aiWrite'

/** Writes each text in turn as the editor would, and returns what it holds after each. */
function writeAll(texts: readonly string[], final = false): string[] {
  let written = ''
  return texts.map((next, i) => {
    const step = planWrite(written, next, final && i === texts.length - 1)
    if (step) written = applyStep(written, step)
    return written
  })
}

describe('what an AI writes into an editor', () => {
  test('whole lines as they come; the unfinished last one waits until the end', () => {
    expect(writeAll(['Sum', 'Summary\n', 'Summary\n\n## Ca', 'Summary\n\n## Calvin cycle'], true)).toEqual([
      '',
      'Summary\n',
      'Summary\n\n',
      'Summary\n\n## Calvin cycle',
    ])
  })

  test('the smallest change: the common start kept, the rest replaced when the text says otherwise', () => {
    expect(planWrite('a\nb\n', 'a\nb\nc\n', false)).toEqual({ from: 4, to: 4, insert: 'c\n' })
    expect(planWrite('a\nb\n', 'a\nB\n', true)).toEqual({ from: 2, to: 4, insert: 'B\n' })
    expect(planWrite('a\nb\n', 'a\n', true)).toEqual({ from: 2, to: 4, insert: '' })
  })

  test('nothing to change: none yet, the same text, or a partial text not yet past what is written', () => {
    expect(planWrite('', 'half a line', false)).toBeNull()
    expect(planWrite('a\n', 'a\n', true)).toBeNull()
    expect(planWrite('a\nb\n', 'a\n', false)).toBeNull()
    expect(planWrite('a\nb\n', 'a\nb', false)).toBeNull()
  })

  test('a step applied gives the text planned', () => {
    const written = 'one\ntwo\n'
    for (const [next, final] of [
      ['one\ntwo\nthree\n', false],
      ['one\n2\n', true],
      ['', true],
    ] as const) {
      const step = planWrite(written, next, final)
      expect(step === null ? written : applyStep(written, step)).toBe(next)
    }
  })
})
