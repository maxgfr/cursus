import type { Id } from '../contracts/workspace'
import type { CardState } from './fsrs'

/** Lapses that make a card a leech, unless the settings say otherwise (`leechThreshold`). */
export const LEECH_LAPSES = 8

export function isLeech(state: CardState, threshold = LEECH_LAPSES): boolean {
  return state.lapses >= threshold
}

/** Whether the answer that took a card from `before` to `after` made it a leech (it was not one yet). */
export function becameLeech(before: CardState, after: CardState, threshold = LEECH_LAPSES): boolean {
  return !isLeech(before, threshold) && isLeech(after, threshold)
}

/** Leech card ids, sorted for a stable display. */
export function leeches(states: Iterable<CardState>, threshold = LEECH_LAPSES): Id[] {
  const out: Id[] = []
  for (const s of states) if (isLeech(s, threshold)) out.push(s.cardId)
  return out.sort()
}
