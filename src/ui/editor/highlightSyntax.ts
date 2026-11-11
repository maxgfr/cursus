import type { DelimiterType, MarkdownConfig } from '@lezer/markdown'

// The same highlights the renderer reads (src/core/content/highlight.ts): `==…==` and `!!…!!`.
const EQUALS = 61
const BANG = 33
const PUNCTUATION = /[\p{P}\p{S}]/u

const HIGHLIGHT: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' }
const IMPORTANT: DelimiterType = { resolve: 'Important', mark: 'ImportantMark' }

/** A two-character marker parsed as GFM parses `~~`: it opens before a word and closes after one. */
function delimiter(name: string, code: number, type: DelimiterType): NonNullable<MarkdownConfig['parseInline']>[0] {
  return {
    name,
    after: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== code || cx.char(pos + 1) !== code || cx.char(pos + 2) === code) return -1
      const before = cx.slice(pos - 1, pos)
      const after = cx.slice(pos + 2, pos + 3)
      const sBefore = /\s|^$/.test(before)
      const sAfter = /\s|^$/.test(after)
      const pBefore = PUNCTUATION.test(before)
      const pAfter = PUNCTUATION.test(after)
      return cx.addDelimiter(
        type,
        pos,
        pos + 2,
        !sAfter && (!pAfter || sBefore || pBefore),
        !sBefore && (!pBefore || sAfter || pAfter),
      )
    },
  }
}

/** Lezer Markdown nodes for the renderer's highlights: `Highlight` and `Important`, each with its two marks. */
export const highlightSyntax: MarkdownConfig = {
  defineNodes: ['Highlight', 'HighlightMark', 'Important', 'ImportantMark'],
  parseInline: [delimiter('Highlight', EQUALS, HIGHLIGHT), delimiter('Important', BANG, IMPORTANT)],
}
