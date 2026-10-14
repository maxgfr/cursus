import DOMPurify from 'dompurify'
import katex from 'katex'
import { Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked'

/** Maps the sha256 of a `cursus-blob:<sha256>` reference to a displayable URL (usually an object URL). */
export type BlobResolver = (sha256: string) => string | null

export interface RenderOptions {
  resolveBlob?: BlobResolver
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

/** Renders untrusted Markdown (with `$…$` / `$$…$$` maths) to sanitized HTML. */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const html = marked.parse(source, { async: false })
  const purify = DOMPurify(window)
  const resolve = options.resolveBlob
  purify.addHook('afterSanitizeAttributes', (node) => {
    for (const attr of URI_ATTRS) {
      const value = node.getAttribute(attr)
      if (value === null || !value.trim().toLowerCase().startsWith(BLOB_SCHEME)) continue
      const sha = BLOB_REF.exec(value.trim())?.[1]
      const url = sha && resolve ? resolve(sha) : null
      if (url && /^(?:blob:|data:image\/)/.test(url)) node.setAttribute(attr, url)
      else node.removeAttribute(attr)
    }
  })
  return purify.sanitize(html, {
    ADD_TAGS: ['audio', 'source'],
    ADD_ATTR: ['controls', 'preload'],
    ALLOWED_URI_REGEXP: ALLOWED_URI,
  })
}
