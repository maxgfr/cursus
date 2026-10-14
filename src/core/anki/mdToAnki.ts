import { Marked } from 'marked'

/** Maps a blob id to the media file name used in the exported package, or null when unavailable. */
export type MediaNamer = (blobId: string) => string | null

const marked = new Marked({ gfm: true, breaks: false, async: false })
const BLOB = /cursus-blob:([0-9a-f]{64})/g
const AUDIO = /<audio\b[^>]*?\bsrc\s*=\s*["']cursus-blob:([0-9a-f]{64})["'][^>]*>\s*(?:<\/audio>)?/gi

/** Blob ids referenced by a Markdown text. */
export function blobRefs(md: string): string[] {
  return [...new Set([...md.matchAll(BLOB)].map((m) => m[1] as string))]
}

/** Cursus Markdown to Anki field HTML: `$…$`/`$$…$$` become MathJax delimiters, blobs become media files. */
export function markdownToAnki(md: string, name: MediaNamer): string {
  const kept: string[] = []
  const hold = (s: string): string => {
    kept.push(s)
    return `CURSUSKEPT${kept.length - 1}X`
  }
  const src = md
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => hold(`\\[${escapeHtml(tex.trim())}\\]`))
    .replace(/\$(?!\$)((?:\\.|[^\\$\n])+?)\$(?!\d)/g, (_m, tex: string) => hold(`\\(${escapeHtml(tex)}\\)`))
    .replace(AUDIO, (_m, id: string) => {
      const file = name(id)
      return file ? hold(`[sound:${file}]`) : ''
    })
  let html = marked.parse(src, { async: false }).trim()
  const single = /^<p>([\s\S]*)<\/p>$/.exec(html)
  if (single?.[1] !== undefined && !single[1].includes('<p>')) html = single[1]
  return html
    .replace(BLOB, (_m, id: string) => name(id) ?? '')
    .replace(/CURSUSKEPT(\d+)X/g, (_m, i: string) => kept[Number(i)] ?? '')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
