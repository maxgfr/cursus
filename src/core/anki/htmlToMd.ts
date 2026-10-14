import TurndownService from 'turndown'

/** Converts an HTML fragment to Markdown. Injectable so callers without a DOM-capable turndown can swap it. */
export type HtmlConverter = (html: string) => string

let service: TurndownService | null = null

export const turndownConverter: HtmlConverter = (html) => {
  service ??= new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', emDelimiter: '*' })
  return service.turndown(html)
}

/** Maps an Anki media file name to a blob id, or null when the file is missing from the package. */
export type MediaResolver = (name: string) => string | null

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, e: string) => ENTITIES[e] ?? _m)
}

export const SOUND = /\[sound:([^\]]+)\]/g
export const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi

/** Media file names referenced by a field (images and sounds). */
export function mediaRefs(html: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(IMG_SRC)) out.add(decodeEntities(m[3] ?? ''))
  for (const m of html.matchAll(SOUND)) out.add(decodeEntities(m[1] ?? ''))
  return [...out]
}

/**
 * Anki field HTML to Cursus Markdown: maths `\(…\)`/`\[…\]` become `$…$`/`$$…$$`, images and
 * `[sound:]` point at `cursus-blob:` ids. Protected spans go through turndown as inert placeholders.
 */
export function ankiToMarkdown(
  html: string,
  resolve: MediaResolver,
  convert: HtmlConverter = turndownConverter,
): string {
  const kept: string[] = []
  const hold = (s: string): string => {
    kept.push(s)
    return `CURSUSKEPT${kept.length - 1}X`
  }
  let src = html
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, tex: string) => hold(`$$${decodeEntities(tex)}$$`))
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, tex: string) => hold(`$${decodeEntities(tex).trim()}$`))
    .replace(SOUND, (_m, name: string) => {
      const id = resolve(decodeEntities(name))
      return id ? hold(`<audio controls src="cursus-blob:${id}"></audio>`) : ''
    })
  src = src.replace(IMG_SRC, (_m, pre: string, q: string, name: string) => {
    const id = resolve(decodeEntities(name))
    return `${pre}${q}${id ? `cursus-blob:${id}` : ''}${q}`
  })
  return convert(src)
    .replace(/CURSUSKEPT(\d+)X/g, (_m, i: string) => kept[Number(i)] ?? '')
    .trim()
}
