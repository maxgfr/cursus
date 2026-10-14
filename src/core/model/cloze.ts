export interface ClozeCard {
  index: number
  front: string
  back: string
}

const CLOZE = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/gs

/** Extracts distinct cloze indexes (sorted ascending). */
export function clozeIndexes(text: string): number[] {
  const set = new Set<number>()
  for (const m of text.matchAll(CLOZE)) set.add(Number(m[1]))
  return [...set].sort((a, b) => a - b)
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
