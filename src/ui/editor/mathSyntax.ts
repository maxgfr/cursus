import type { BlockContext, LeafBlock, LeafBlockParser, Line, MarkdownConfig } from '@lezer/markdown'

// The same maths the renderer reads (src/core/content/markdown.ts): `$…$` inline, `$$…$$` on lines of their own.
const INLINE = /^\$(?!\$)((?:\\.|[^\\$\n])+?)\$(?!\d)/
const BLOCK_OPEN = /^\$\$/
/** `$$…$$` closed on its first line, nothing but spaces after. */
const ONE_LINE = /^\$\$[\s\S]+?(\$\$)[ \t]*$/
/** The closing `$$` of a later line: the last thing on it. */
const CLOSE = /\$\$[ \t]*$/

const DOLLAR = 36

/** A paragraph that opens with `$$` becomes a maths block once a line ends with `$$`, else stays a paragraph. */
class MathBlockParser implements LeafBlockParser {
  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    const one = ONE_LINE.exec(leaf.content)
    if (one && !leaf.content.includes('\n')) {
      // `$$…$$` then more text below: the block ends with its own line, the next line starts afresh.
      cx.addLeafElement(leaf, mathBlock(cx, leaf.start, leaf.start + leaf.content.trimEnd().length))
      return true
    }
    const close = CLOSE.exec(line.text)
    if (!close || close.index < line.pos) return false
    const end = cx.lineStart + close.index + 2
    cx.nextLine()
    cx.addLeafElement(leaf, mathBlock(cx, leaf.start, end))
    return true
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    if (leaf.content.includes('\n') || !ONE_LINE.test(leaf.content)) return false
    cx.addLeafElement(leaf, mathBlock(cx, leaf.start, leaf.start + leaf.content.trimEnd().length))
    return true
  }
}

function mathBlock(cx: BlockContext, from: number, to: number) {
  return cx.elt('BlockMath', from, to, [cx.elt('BlockMathMark', from, from + 2), cx.elt('BlockMathMark', to - 2, to)])
}

/**
 * Lezer Markdown nodes for the renderer's maths: `InlineMath` and `BlockMath`, each with its `$` / `$$` marks.
 * What sits between the dollars is never read as emphasis, links or the like.
 */
export const mathSyntax: MarkdownConfig = {
  defineNodes: ['InlineMath', 'InlineMathMark', 'BlockMath', 'BlockMathMark'],
  parseInline: [
    {
      name: 'InlineMath',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1
        const m = INLINE.exec(cx.slice(pos, cx.end))
        if (!m || (m[1] ?? '').trim() === '') return -1
        const end = pos + m[0].length
        return cx.addElement(
          cx.elt('InlineMath', pos, end, [
            cx.elt('InlineMathMark', pos, pos + 1),
            cx.elt('InlineMathMark', end - 1, end),
          ]),
        )
      },
    },
  ],
  parseBlock: [
    {
      name: 'BlockMath',
      leaf: (_cx, leaf) => (BLOCK_OPEN.test(leaf.content) ? new MathBlockParser() : null),
      // A `$$` line ends the paragraph above it, as in the renderer; the lines of an open maths block do not.
      endLeaf: (_cx, line, leaf) =>
        line.next === DOLLAR &&
        line.text.charCodeAt(line.pos + 1) === DOLLAR &&
        !leaf.parsers.some((p) => p instanceof MathBlockParser),
    },
  ],
}
