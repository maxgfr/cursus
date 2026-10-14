import type { ModelWorkspace } from '../../core/model/workspace'
import { applyForward } from '../History/replay.ts'
import type { CardFields } from './draft.ts'

/** Characters of unchanged text on each side that locate a local edit in the current text. */
const CONTEXT = 24

/**
 * Three-way merge of one text: `base` is what the draft was seeded from, `mine` the draft, `current`
 * what the card holds now. The local change (one prefix/suffix span, base → mine) is replayed where
 * its surrounding context sits in `current`. Returns null when that place cannot be found exactly
 * once: the caller keeps the remote text and the draft rather than guess.
 */
export function mergeText(base: string, mine: string, current: string): string | null {
  if (mine === base) return current
  if (current === base || current === mine) return mine
  let p = 0
  const max = Math.min(base.length, mine.length)
  while (p < max && base[p] === mine[p]) p++
  let s = 0
  while (s < max - p && base[base.length - 1 - s] === mine[mine.length - 1 - s]) s++
  const removed = base.slice(p, base.length - s)
  const inserted = mine.slice(p, mine.length - s)
  const before = base.slice(Math.max(0, p - CONTEXT), p)
  const after = base.slice(base.length - s, Math.min(base.length, base.length - s + CONTEXT))
  const needle = before + removed + after
  if (needle === '') return null
  const at = current.indexOf(needle)
  if (at < 0 || current.indexOf(needle, at + 1) >= 0) return null
  // An edit at the very start (or end) of the text must still be at the start (or end).
  if (p === 0 && at !== 0) return null
  if (s === 0 && at + needle.length !== current.length) return null
  return current.slice(0, at) + before + inserted + after + current.slice(at + needle.length)
}

export type TextName = 'front' | 'back'

/**
 * Saves an existing card's draft in one batch, writing only what the draft changed since `base`.
 * Fields also changed elsewhere are merged; those that cannot be are left as they are and returned.
 */
export function saveExisting(ws: ModelWorkspace, id: string, base: CardFields, mine: CardFields): TextName[] {
  const conflicts: TextName[] = []
  ws.batch(() => {
    if (mine.kind !== base.kind) ws.cards.update(id, { kind: mine.kind })
    for (const field of ['front', 'back'] as const) {
      if (mine[field] === base[field]) continue
      const text = ws.text({ id, field })
      const merged = mergeText(base[field], mine[field], text.toString())
      if (merged === null) conflicts.push(field)
      else applyForward(text, merged)
    }
  })
  return conflicts
}
