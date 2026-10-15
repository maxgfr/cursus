import type { CardDraft } from './schemas'

/** Comparison key of a card front: cloze markup unwrapped, case, accents and punctuation ignored. */
export function frontKey(front: string): string {
  return front
    .replace(/\{\{c\d+::(.*?)(?:::[^}]*)?\}\}/g, '$1')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Drops drafts that repeat each other or a card the course already has. */
export function dedupeDrafts(
  drafts: readonly CardDraft[],
  existingFronts: readonly string[],
): { kept: CardDraft[]; dropped: number } {
  const flagged = flagDuplicates(drafts, existingFronts)
  const kept = flagged.filter((d) => !d.duplicate).map(({ duplicate: _, ...d }) => d)
  return { kept, dropped: drafts.length - kept.length }
}

/**
 * Every draft, in order, each marked `duplicate` when it repeats an earlier draft or a card the course already has
 * (an empty front counts as one: there is nothing to save).
 */
export function flagDuplicates<D extends CardDraft>(
  drafts: readonly D[],
  existingFronts: readonly string[],
): (D & { duplicate: boolean })[] {
  const seen = new Set(existingFronts.map(frontKey))
  return drafts.map((d) => {
    const k = frontKey(d.front)
    const duplicate = k === '' || seen.has(k)
    seen.add(k)
    return { ...d, duplicate }
  })
}
