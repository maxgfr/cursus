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
