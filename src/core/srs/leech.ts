import type { Id } from '../contracts/workspace'
import type { CardState } from './fsrs'

export const LEECH_LAPSES = 8

export function isLeech(state: CardState): boolean {
  return state.lapses >= LEECH_LAPSES
}

/** Leech card ids, sorted for a stable display. */
export function leeches(states: Iterable<CardState>): Id[] {
  const out: Id[] = []
  for (const s of states) if (isLeech(s)) out.push(s.cardId)
  return out.sort()
}
