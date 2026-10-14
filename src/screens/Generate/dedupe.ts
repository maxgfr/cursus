import type { CardDraft } from '../../core/ai/schemas'

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
  const seen = new Set(existingFronts.map(frontKey))
  const kept: CardDraft[] = []
  for (const d of drafts) {
    const k = frontKey(d.front)
    if (k === '' || seen.has(k)) continue
    seen.add(k)
    kept.push(d)
  }
  return { kept, dropped: drafts.length - kept.length }
}
