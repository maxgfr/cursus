import type { TokenizerAndRendererExtension, Tokens } from 'marked'

/**
 * The two ways to make words stand out, by their Markdown marker: `==text==` highlights them, `!!text!!` marks them
 * as important (another colour). The text inside is Markdown too.
 */
export type Highlight = 'highlight' | 'important'

export const HIGHLIGHT_MARKERS: Readonly<Record<Highlight, '==' | '!!'>> = { highlight: '==', important: '!!' }

/**
 * The marked element `kind` makes at the start of `src`, if any: its whole source and its text. The text neither
 * starts nor ends with white space or the marker's character, and stays on one line.
 */
export function matchHighlight(kind: Highlight, src: string): { raw: string; text: string } | null {
  const marker = HIGHLIGHT_MARKERS[kind]
  const c = marker.charAt(0)
  if (!src.startsWith(marker) || src.charAt(2) === c) return null
  for (let i = 3; i < src.length; i++) {
    const at = src.charAt(i)
    if (at === '\n') return null
    if (at === '\\') {
      i++
      continue
    }
    if (at !== c || src.charAt(i + 1) !== c || src.charAt(i + 2) === c) continue
    const text = src.slice(2, i)
    if (/^\s|\s$/.test(text) || text.endsWith(c)) continue
    return { raw: src.slice(0, i + 2), text }
  }
  return null
}

interface HighlightToken extends Tokens.Generic {
  type: Highlight
  text: string
  tokens: Tokens.Generic[]
}

/** The marked extension that reads `kind`, rendered by `open` and `</mark>` around its text. */
export function highlightExtension(kind: Highlight, open: string): TokenizerAndRendererExtension {
  const marker = HIGHLIGHT_MARKERS[kind]
  return {
    name: kind,
    level: 'inline',
    start: (src) => {
      const i = src.indexOf(marker)
      return i < 0 ? undefined : i
    },
    tokenizer(src): HighlightToken | undefined {
      const m = matchHighlight(kind, src)
      if (m === null) return undefined
      return { type: kind, raw: m.raw, text: m.text, tokens: this.lexer.inlineTokens(m.text) }
    },
    renderer(token) {
      return `${open}${this.parser.parseInline(token.tokens ?? [])}</mark>`
    },
  }
}
