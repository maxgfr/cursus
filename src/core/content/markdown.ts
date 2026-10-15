import DOMPurify from 'dompurify'
import katex from 'katex'
import { Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked'

/** Maps the sha256 of a `cursus-blob:<sha256>` reference to a displayable URL (usually an object URL). */
export type BlobResolver = (sha256: string) => string | null

export interface RenderOptions {
  resolveBlob?: BlobResolver
  /** Every line break is kept (text read from a file, line by line), not only a blank line between paragraphs. */
  lineBreaks?: boolean
}

const BLOB_SCHEME = 'cursus-blob:'
const BLOB_REF = /^cursus-blob:([0-9a-f]{64})$/
const URI_ATTRS = ['src', 'href', 'poster', 'xlink:href'] as const
// DOMPurify's default allow-list plus our own blob scheme (rewritten or removed in a hook below).
const ALLOWED_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|cursus-blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

interface MathToken extends Tokens.Generic {
  type: 'mathBlock' | 'mathInline'
  text: string
}

function renderMath(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, { displayMode, throwOnError: false, trust: false, strict: 'ignore' })
}

const mathBlock: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start: (src) => src.match(/^ {0,3}\$\$/m)?.index,
  tokenizer(src): MathToken | undefined {
    const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src)
    if (!m || m[1] === undefined) return undefined
    return { type: 'mathBlock', raw: m[0], text: m[1].trim() }
  },
  renderer: (token) => `<div class="math-block">${renderMath(String(token.text), true)}</div>\n`,
}

const mathInline: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start: (src) => {
    const i = src.indexOf('$')
    return i < 0 ? undefined : i
  },
  tokenizer(src): MathToken | undefined {
    const m = /^\$(?!\$)((?:\\.|[^\\$\n])+?)\$(?!\d)/.exec(src)
    if (!m || m[1] === undefined || m[1].trim() === '') return undefined
    return { type: 'mathInline', raw: m[0], text: m[1] }
  },
  renderer: (token) => renderMath(String(token.text), false),
}

const marked = new Marked({ gfm: true, breaks: false, async: false })
marked.use({ extensions: [mathBlock, mathInline] })

/** Class of the box a rendered table scrolls in (styled by the renderer). */
const TABLE_SCROLL = 'table-scroll'
const TABLE_OPEN = /<table(?=[\s>])[^>]*>/g
const TABLE_CLOSE = /<\/table>/g

/** Renders untrusted Markdown (with `$…$` / `$$…$$` maths) to sanitized HTML. */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  return sanitize(marked.parse(source, { async: false, breaks: options.lineBreaks === true }), options)
}

/** Same as `renderMarkdown` for a run of inline text (no paragraph around it), e.g. one `$…$` formula. */
export function renderMarkdownInline(source: string, options: RenderOptions = {}): string {
  return sanitize(marked.parseInline(source, { async: false }), options)
}

function sanitize(html: string, options: RenderOptions): string {
  const purify = DOMPurify(window)
  const resolve = options.resolveBlob
  purify.addHook('afterSanitizeAttributes', (node) => {
    // A code block scrolls sideways when its lines are long: it takes the focus, so a keyboard can scroll it too.
    if (node.nodeName === 'PRE') node.setAttribute('tabindex', '0')
    for (const attr of URI_ATTRS) {
      const value = node.getAttribute(attr)
      if (value === null || !value.trim().toLowerCase().startsWith(BLOB_SCHEME)) continue
      const sha = BLOB_REF.exec(value.trim())?.[1]
      const url = sha && resolve ? resolve(sha) : null
      if (url && /^(?:blob:|data:image\/)/.test(url)) node.setAttribute(attr, url)
      else node.removeAttribute(attr)
    }
  })
  const clean = purify.sanitize(html, {
    ADD_TAGS: ['audio', 'source'],
    ADD_ATTR: ['controls', 'preload'],
    ALLOWED_URI_REGEXP: ALLOWED_URI,
  })
  // A table wider than the column scrolls sideways in a box of its own (focusable, like a code block), so its
  // words are never cut and nothing spills past the page. Sanitized output is well formed: tags come in pairs.
  return clean.replace(TABLE_OPEN, `<div class="${TABLE_SCROLL}" tabindex="0">$&`).replace(TABLE_CLOSE, '$&</div>')
}
