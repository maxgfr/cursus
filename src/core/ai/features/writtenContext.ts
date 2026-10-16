/**
 * What the student wrote where they are, for the chat: their cards (question and answer, a cloze card's text with
 * its deletions filled in and its extra) and their study sheets, as passages the answer cites like a source's. The
 * card on screen comes first, in full, then the other cards of its section, cut short, then that section's sheets;
 * a section or a course gives its own cards and sheets first, then the rest of the course. Within the budget, in
 * that order: the first passage that does not fit is cut, what follows is left out and counted, for a note.
 */
import { clozePlain } from '../../model/cloze'
import type { ModelWorkspace } from '../../model/workspace'
import { type Chunk, estimateTokens } from '../retrieval'

export interface WrittenCard {
  id: string
  kind: 'basic' | 'cloze'
  front: string
  back: string
  /** In the place on screen (the card's section, or the section or course open); else elsewhere in the course. */
  near: boolean
}

export interface WrittenSheet {
  id: string
  title: string
  body: string
  keyPoints: readonly string[]
  near: boolean
}

export interface WrittenPlace {
  /** The card on screen, given first; left out while its answer is hidden (the screen describes it, guarded). */
  card?: { id: string; hidden: boolean }
  cards: readonly WrittenCard[]
  sheets: readonly WrittenSheet[]
}

export interface Written {
  chunks: Chunk[]
  /** Cards and sheets cut or left out for length. */
  omitted: number
}

/** With a card on screen, the other cards of its section show this much of each face. */
export const LIGHT_CHARS = 300
/** Longest passage, as a source's are split. */
const MAX_PASSAGE = 2000
/** Per-passage overhead of the source delimiters, in tokens (as retrieval counts it). */
const PASSAGE_OVERHEAD = 16
/** A passage is cut to the room left only when that room is worth it. */
const MIN_CUT_CHARS = 200

const clip = (s: string, light: boolean) => (light && s.length > LIGHT_CHARS ? `${s.slice(0, LIGHT_CHARS)}…` : s)

function cardText(c: WrittenCard, light: boolean): string {
  const front = c.front.trim()
  const back = c.back.trim()
  const lines =
    c.kind === 'cloze'
      ? [`Cloze card: ${clip(clozePlain(front), light)}`, back ? `Extra: ${clip(back, light)}` : '']
      : [`Card question: ${clip(front, light)}`, back ? `Card answer: ${clip(back, light)}` : '']
  return lines.filter((l) => l !== '').join('\n')
}

function sheetText(s: WrittenSheet): string {
  const points = s.keyPoints.map((p) => p.trim()).filter((p) => p !== '')
  return [`Study sheet: ${s.title.trim()}`, s.body.trim(), points.map((p) => `- ${p}`).join('\n')]
    .filter((p) => p !== '')
    .join('\n\n')
}

function split(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += MAX_PASSAGE) out.push(text.slice(i, i + MAX_PASSAGE))
  return out
}

/** The passages of what the student wrote, in priority order, within `budgetTokens`. */
export function writtenChunks(place: WrittenPlace, budgetTokens: number): Written {
  const onCard = place.card
  const light = onCard !== undefined
  const focus = onCard && !onCard.hidden ? place.cards.find((c) => c.id === onCard.id) : undefined
  const others = place.cards.filter((c) => c.id !== onCard?.id && `${c.front}${c.back}`.trim() !== '')
  const sheets = place.sheets.filter((s) => `${s.title}${s.body}${s.keyPoints.join('')}`.trim() !== '')
  const items: { id: string; text: string }[] = [
    ...(focus ? [{ id: focus.id, text: cardText(focus, false) }] : []),
    ...others.filter((c) => c.near).map((c) => ({ id: c.id, text: cardText(c, light) })),
    ...sheets.filter((s) => s.near).map((s) => ({ id: s.id, text: sheetText(s) })),
    // A card on screen keeps to its section; a section or a course goes on with the rest of the course.
    ...(light
      ? []
      : [
          ...others.filter((c) => !c.near).map((c) => ({ id: c.id, text: cardText(c, false) })),
          ...sheets.filter((s) => !s.near).map((s) => ({ id: s.id, text: sheetText(s) })),
        ]),
  ]
  const chunks: Chunk[] = []
  let used = 0
  let omitted = 0
  for (const item of items) {
    if (omitted > 0) {
      omitted++
      continue
    }
    for (const text of split(item.text)) {
      const cost = estimateTokens(text) + PASSAGE_OVERHEAD
      if (used + cost <= budgetTokens) {
        used += cost
        chunks.push({ sourceId: item.id, text })
        continue
      }
      const room = (budgetTokens - used - PASSAGE_OVERHEAD) * 4 - 1
      if (room >= MIN_CUT_CHARS) chunks.push({ sourceId: item.id, text: `${text.slice(0, room)}…` })
      used = budgetTokens
      omitted++
      break
    }
  }
  return { chunks, omitted }
}

/**
 * What the student wrote in the course, read for `writtenChunks`: near the card on screen (its section, at the
 * course root the cards there), else inside the section open (its subsections included), else the whole course.
 */
export function readWritten(
  ws: ModelWorkspace,
  place: { courseId: string; sectionId?: string },
  card?: { id: string; hidden: boolean },
): WrittenPlace {
  const tree = ws.sections.tree()
  const onScreen = card ? ws.cards.get(card.id) : undefined
  const cardSection = onScreen ? tree.sectionOf(onScreen) : null
  const near = (item: { courseId: string; sectionId?: string }): boolean => {
    if (onScreen) return tree.sectionOf(item) === cardSection
    return tree.contains(place, item)
  }
  const text = (id: string, field: 'front' | 'back' | 'body') => ws.text({ id, field }).toString()
  return {
    ...(card ? { card } : {}),
    cards: ws.cards.list({ courseId: place.courseId }).map((c) => ({
      id: c.id,
      kind: c.kind,
      front: text(c.id, 'front'),
      back: text(c.id, 'back'),
      near: near(c),
    })),
    sheets: ws.fiches.list({ courseId: place.courseId }).map((f) => ({
      id: f.id,
      title: f.title,
      body: text(f.id, 'body'),
      keyPoints: (f.keyPoints ?? []).map((k) => k.text),
      near: near(f),
    })),
  }
}
