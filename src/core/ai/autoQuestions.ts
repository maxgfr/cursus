/**
 * Questions proposed on a source when the student asks for them (« Suggest cards » on a source, its slides or a
 * photo): never on their own when something is added.
 *
 * This module turns the workspace into one run over one source (`planRun`): destination (the source's own
 * place), output language, questions per unit, types, difficulty, existing cards to avoid, and the duplicate
 * test that keeps rejected questions from ever coming back. `jobs.ts` runs the plans one source at a time on the
 * device. The synced `autoQuestions.*` prefs of earlier versions are no longer read.
 *
 * Generation goes through a `QuestionGenerator`: the built-in one is `deckQuestions` (slides, pages, sections,
 * notes split by heading, or a photo given as one unit with its image to a vision model). Another path plugs
 * in as an adapter, e.g. `photoToCards` for photos: wrap it to return `DeckQuestion`s citing unit 1.
 */
import { detectLanguage } from '../content/language'
import type { Id, StudyScope } from '../contracts/workspace'
import { AUTO_QUESTION_DEFAULTS, type NewDraft } from '../model/drafts'
import type { CourseRecord, SourceRecord } from '../model/schema'
import type { ModelWorkspace } from '../model/workspace'
import type { CatalogModel } from './catalogTrim'
import { type FeatureCtx, outputLanguage } from './client'
import {
  CardTextIndex,
  type DeckQuestion,
  type DeckQuestionsInput,
  deckQuestions,
  estimateDeckQuestionsCost,
} from './features/deckQuestions'
import type { DeckUnitInput } from './features/readDeck'

/**
 * Why a source was queued: asked for by the student. `added` (queued on its own when a source was added) is only
 * read from queues stored by earlier versions: such a job is cancelled, never run.
 */
export type JobReason = 'added' | 'manual'

export interface GeneratorEstimate {
  /** USD. */
  cost: number
  calls: number
  /** Units still to read. */
  units: number
}

export interface GeneratorResult {
  /** Every question kept, in unit order (those already handed out through `onProgress` included). */
  questions: DeckQuestion[]
  duplicates: number
}

/** How questions are written for a source; `deckGenerator` unless an adapter is given for its kind. */
export interface QuestionGenerator {
  estimate(info: CatalogModel, input: DeckQuestionsInput): GeneratorEstimate
  generate(ctx: FeatureCtx, input: DeckQuestionsInput): Promise<GeneratorResult>
}

export const deckGenerator: QuestionGenerator = {
  estimate(info, input) {
    const e = estimateDeckQuestionsCost(info, input)
    return { cost: e.cost, calls: e.calls, units: e.units.length }
  },
  generate: (ctx, input) => deckQuestions(ctx, input),
}

/** What a source holds, as units a model reads (the UI reads files; `noteUnits` splits a note). */
export interface SourceContent {
  title?: string
  units: DeckUnitInput[]
}

// ---------------------------------------------------------------------------------------------------------
// Notes

/** Characters per unit at most when a note section is long: it is split at paragraph breaks. */
export const NOTE_UNIT_CHARS = 6000
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

function splitLong(text: string): string[] {
  if (text.length <= NOTE_UNIT_CHARS) return [text]
  const out: string[] = []
  let cur = ''
  for (const para of text.split(/\n{2,}/)) {
    const next = cur === '' ? para : `${cur}\n\n${para}`
    if (next.length > NOTE_UNIT_CHARS && cur !== '') {
      out.push(cur)
      cur = para
    } else cur = next
    while (cur.length > NOTE_UNIT_CHARS) {
      out.push(cur.slice(0, NOTE_UNIT_CHARS))
      cur = cur.slice(NOTE_UNIT_CHARS)
    }
  }
  if (cur !== '') out.push(cur)
  return out
}

/** A Markdown note as units: one per heading (« section 3 »), long ones split; text before the first heading too. */
export function noteUnits(title: string, markdown: string): DeckUnitInput[] {
  const sections: { title: string; lines: string[] }[] = [{ title, lines: [] }]
  let fenced = false
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const h = fenced ? null : HEADING.exec(line)
    if (h?.[2]) sections.push({ title: h[2], lines: [] })
    else sections[sections.length - 1]?.lines.push(line)
  }
  const units: DeckUnitInput[] = []
  for (const s of sections) {
    const text = s.lines.join('\n').trim()
    if (text === '') continue
    for (const part of splitLong(text)) {
      const index = units.length + 1
      units.push({ index, kind: 'section', label: String(index), title: s.title, text: part })
    }
  }
  return units
}

// ---------------------------------------------------------------------------------------------------------
// Planning a run

/** The course cards' fronts (live cards), to drop near-duplicates of what the student already has. */
export function existingCardTexts(ws: ModelWorkspace, courseId: Id): string[] {
  return ws.cards.list({ courseId }).map((c) => ws.text({ id: c.id, field: 'front' }).toString())
}

/**
 * The duplicate test of a run: every question ever rejected (anywhere), and every question already proposed
 * for this source whatever became of it. Rebuilt when the drafts change, so a rejection made while the run
 * goes on counts at once.
 */
export function draftDuplicates(ws: ModelWorkspace, sourceId: Id): (q: Pick<DeckQuestion, 'front'>) => boolean {
  let seen: unknown = null
  let index = new CardTextIndex()
  return (q) => {
    const all = ws.drafts.all()
    if (all !== seen) {
      seen = all
      index = new CardTextIndex(ws.drafts.rejectedTexts())
      for (const d of all) {
        if (d.sourceId !== sourceId) continue
        index.add(d.proposed)
        if (d.front !== d.proposed) index.add(d.front)
      }
    }
    return index.has(q.front)
  }
}

function liveCourse(ws: ModelWorkspace, id: Id): CourseRecord | undefined {
  const c = ws.courses.get(id)
  return c && c.deletedAt === undefined ? c : undefined
}

/** Where a source's questions are bound by default: its own course or subset (the inbox can send them elsewhere). */
export function destinationOf(source: SourceRecord): StudyScope {
  return source.sectionId === undefined
    ? { courseId: source.courseId }
    : { courseId: source.courseId, sectionId: source.sectionId }
}

export interface RunPlan {
  source: SourceRecord
  destination: StudyScope
  /** Output language name for the model. */
  language: string
  /**
   * The course names no language: the questions follow the language the document is written in, when it tells
   * (`language`, the interface's, is the fallback).
   */
  languageFromContent: boolean
  /** Everything `deckQuestions` needs but the units, the progress and its callback. */
  input: Omit<DeckQuestionsInput, 'units' | 'resume' | 'onProgress'>
}

export type PlanOutcome = RunPlan | 'source-gone'

/** The language a document's units are written in, as a name for the model, when it tells. */
export function unitsLanguage(units: readonly DeckUnitInput[], uiLocale: string): string | undefined {
  const code = detectLanguage(units.map((u) => [u.title, u.text, u.notes ?? ''].join('\n')).join('\n'))
  return code === undefined ? undefined : outputLanguage(code, uiLocale)
}

/** One run over one source: what to ask the model, and where its questions are bound. */
export function planRun(ws: ModelWorkspace, sourceId: Id): PlanOutcome {
  const source = ws.sources.get(sourceId)
  if (!source || source.deletedAt !== undefined || ws.sources.list().every((s) => s.id !== sourceId)) {
    return 'source-gone'
  }
  const course = liveCourse(ws, source.courseId)
  if (!course) return 'source-gone'
  const destination = destinationOf(source)
  const named = course.language?.trim() || undefined
  const language = outputLanguage(named, ws.prefs.get('locale'))
  const d = AUTO_QUESTION_DEFAULTS
  const input: RunPlan['input'] = {
    sourceId,
    perUnit: d.perUnit,
    types: d.types,
    difficulty: d.difficulty,
    courseTitle: course.title,
    deckTitle: source.title,
    isDuplicate: draftDuplicates(ws, sourceId),
    existing: existingCardTexts(ws, destination.courseId),
  }
  return { source, destination, language, languageFromContent: named === undefined, input }
}

const HAS_CLOZE = /\{\{c\d+::.+?\}\}/s

/** Questions as drafts bound for the plan's destination, each with its unit's label; malformed ones are left out. */
export function toNewDrafts(
  questions: readonly DeckQuestion[],
  plan: Pick<RunPlan, 'source' | 'destination'>,
  units: readonly DeckUnitInput[],
  model?: string,
): NewDraft[] {
  const byIndex = new Map(units.map((u) => [u.index, u]))
  const out: NewDraft[] = []
  for (const q of questions) {
    if (q.front.trim() === '' || (q.kind === 'cloze' && !HAS_CLOZE.test(q.front))) continue
    const unit = byIndex.get(q.unit)
    const d: NewDraft = {
      sourceId: plan.source.id,
      courseId: plan.destination.courseId,
      unit: Number.isInteger(q.unit) && q.unit >= 0 ? q.unit : 0,
      kind: q.kind,
      type: q.type,
      difficulty: q.difficulty,
      front: q.front,
      back: q.back,
    }
    if (plan.destination.sectionId !== undefined) d.sectionId = plan.destination.sectionId
    if (unit) {
      d.unitKind = unit.kind
      d.unitLabel = unit.label
    }
    if (q.quote !== undefined) d.quote = q.quote
    if (model !== undefined) d.model = model
    out.push(d)
  }
  return out
}
