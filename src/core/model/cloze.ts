export interface ClozeCard {
  index: number
  front: string
  back: string
}

const CLOZE = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/gs

/** Where a `{{cN::answer::hint}}` deletion sits in its text: the whole of it and its answer. */
export interface ClozeSpan {
  index: number
  from: number
  to: number
  answerFrom: number
  answerTo: number
}

/** Every cloze deletion of a text, in order, with offsets (what an editor styles in place). */
export function clozeSpans(text: string): ClozeSpan[] {
  return [...text.matchAll(CLOZE)].map((m) => {
    const answerFrom = m.index + `{{c${m[1]}::`.length
    return {
      index: Number(m[1]),
      from: m.index,
      to: m.index + m[0].length,
      answerFrom,
      answerTo: answerFrom + (m[2] ?? '').length,
    }
  })
}

/** A piece of a cloze text as the student taps it: a word to hide, a blank to show again, or what lies between. */
export type ClozeToken =
  | { kind: 'text'; text: string }
  | { kind: 'word' | 'blank'; text: string; from: number; to: number }

/** Written as a whole, never tapped word by word: pictures, links, code, formulas, addresses. */
const OPAQUE = /!?\[[^\]\n]*\]\([^)\n]*\)|`[^`\n]*`|\$\$.*?\$\$|\$[^$\n]+\$|<[^>\n]+>|https?:\/\/\S+/.source
/** A number with its decimals, or a word with its hyphens; an apostrophe ends one, so « l’osmose » hides « osmose ». */
const WORD = /\p{N}+(?:[.,]\p{N}+)+|[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*/u.source
const TOKEN = new RegExp(`${CLOZE.source}|(${OPAQUE})|${WORD}`, 'gsu')

/** A cloze text cut into tokens, in order; a picture is left out, its reference means nothing to read. */
export function clozeTokens(text: string): ClozeToken[] {
  const out: ClozeToken[] = []
  let at = 0
  const between = (to: number) => {
    if (to > at) out.push({ kind: 'text', text: text.slice(at, to) })
  }
  for (const m of text.matchAll(TOKEN)) {
    between(m.index)
    const to = m.index + m[0].length
    at = to
    if (m[1] !== undefined) out.push({ kind: 'blank', text: m[2] ?? '', from: m.index, to })
    else if (m[4] === undefined) out.push({ kind: 'word', text: m[0], from: m.index, to })
    else if (!m[4].startsWith('!')) out.push({ kind: 'text', text: m[0] })
  }
  between(text.length)
  return out
}

const SAME_LINE_GAP = /^[ \t]*$/

/**
 * The text once a token is tapped: a blank shows its word again, a word next to a blank joins it (two taps hide
 * « cell wall » as one blank), any other word becomes the text's next blank. Blanks keep their numbers: a card's
 * reviews follow its number.
 */
export function toggleClozeToken(text: string, token: Exclude<ClozeToken, { kind: 'text' }>): string {
  const { from, to } = token
  if (token.kind === 'blank') return text.slice(0, from) + token.text + text.slice(to)
  const spans = clozeSpans(text)
  const left = spans.find((s) => s.to <= from && SAME_LINE_GAP.test(text.slice(s.to, from)))
  if (left) {
    return text.slice(0, left.answerTo) + text.slice(left.to, to) + text.slice(left.answerTo, left.to) + text.slice(to)
  }
  const right = spans.find((s) => s.from >= to && SAME_LINE_GAP.test(text.slice(to, s.from)))
  if (right) {
    return (
      text.slice(0, from) +
      text.slice(right.from, right.answerFrom) +
      text.slice(from, right.from) +
      text.slice(right.answerFrom)
    )
  }
  const next = (clozeIndexes(text).at(-1) ?? 0) + 1
  return `${text.slice(0, from)}{{c${next}::${text.slice(from, to)}}}${text.slice(to)}`
}

/** Extracts distinct cloze indexes (sorted ascending). */
export function clozeIndexes(text: string): number[] {
  const set = new Set<number>()
  for (const m of text.matchAll(CLOZE)) set.add(Number(m[1]))
  return [...set].sort((a, b) => a - b)
}

/** The text with every deletion shown as its answer, hints dropped: how a list or a search result names the card. */
export function clozePlain(text: string): string {
  return text.replace(CLOZE, (_m, _n: string, answer: string) => answer)
}

/**
 * One card per distinct cloze index: on the front the active deletions are
 * replaced by `[...]` (or `[hint]`), other deletions show their answer.
 */
export function makeClozeCards(text: string): ClozeCard[] {
  return clozeIndexes(text).map((index) => ({
    index,
    front: text.replace(CLOZE, (_m, n: string, answer: string, hint: string | undefined) =>
      Number(n) === index ? `[${hint ?? '...'}]` : answer,
    ),
    back: text.replace(CLOZE, (_m, _n: string, answer: string) => answer),
  }))
}

/** A deletion as the review shows it: marked, as the editor draws it in a cloze card's text. */
const marked = (inner: string) => `<mark class="cloze">${inner}</mark>`

/**
 * Card `index`'s faces as the review renders them (Markdown): every deletion marked, the card's own deletions as
 * `[...]` (or `[hint]`) on the front. `makeClozeCards` keeps the plain faces (speech, AI).
 */
export function clozeFaces(text: string, index: number): { front: string; back: string } {
  return {
    front: text.replace(CLOZE, (_m, n: string, answer: string, hint: string | undefined) =>
      marked(Number(n) === index ? `[${hint ?? '...'}]` : answer),
    ),
    back: text.replace(CLOZE, (_m, _n: string, answer: string) => marked(answer)),
  }
}
