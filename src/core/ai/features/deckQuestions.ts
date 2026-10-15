/**
 * « Créer les questions depuis un support »: questions per slide, section or page, of the types the app
 * reviews — question/answer, cloze, « explique avec tes mots » — with a difficulty mix, in the course's
 * language (`ctx.language`, resolved by the caller with `outputLanguage`). Every question cites its unit
 * (`unit`, and `sourceRef = { sourceId, page: unit }` like any other citation); a question naming a unit it
 * was not given is dropped, a supporting quote not found in its unit is removed. Near-duplicates of the
 * course's cards (`existing`), of what the caller rejects (`isDuplicate`, e.g. drafts the student already
 * rejected) and of each other are dropped.
 *
 * Long decks go in batches within the model's context (`planDeckBatches`); `onProgress` hands out the
 * questions unit by unit as batches finish (to show progress slide by slide and keep it on the device), and
 * `resume` skips the units already done. `ctx.signal` cancels. Show `estimateDeckQuestionsCost` first.
 * Usage is reported as `generateCards` unless `feature` says otherwise.
 */
import type { CatalogModel } from '../catalogTrim'
import type { FeatureCtx } from '../client'
import { type CostEstimate, estimateCost } from '../cost'
import { estimateTokens } from '../retrieval'
import { type DeckQuestionDraft, deckQuestionsSchema, type SourceRef } from '../schemas'
import type { AiFeature } from '../usage'
import { fence, foldWord } from './explainQuestion'
import {
  askDeck,
  batchKey,
  type DeckBatch,
  type DeckNotion,
  type DeckUnitInput,
  planDeckBatches,
  supportsImages,
  UNITS_RULE,
  unitTokens,
  unseenImages,
} from './readDeck'

export type QuestionType = 'qa' | 'cloze' | 'explain'
export type QuestionDifficulty = 'easy' | 'medium' | 'hard'
export type DifficultyMix = 'easy' | 'mixed' | 'hard'

export const QUESTION_TYPES: readonly QuestionType[] = ['qa', 'cloze', 'explain']
export const MAX_QUESTIONS_PER_UNIT = 10
/**
 * How many questions a unit gets: a fixed number, or `auto`, where the model writes none to
 * `MAX_QUESTIONS_PER_UNIT` by how much there is to learn in the unit (none on a title or transition slide).
 */
export type QuestionCount = number | 'auto'
/**
 * What `auto` is priced at: the average number of questions a unit gets. Course slides and pages mostly carry one
 * to a few notions, and title or transition units none, so 3 questions per unit is a fair, slightly high average.
 */
export const AUTO_QUESTIONS_AVERAGE = 3

/** A fixed count for `count`: itself, clamped, or the average `auto` is priced at. */
export function fixedQuestionCount(count: QuestionCount): number {
  if (count === 'auto') return AUTO_QUESTIONS_AVERAGE
  return Math.min(MAX_QUESTIONS_PER_UNIT, Math.max(1, Math.round(count)))
}
/** Answer tokens per question, for estimates and output limits. */
export const QUESTION_OUTPUT_TOKENS = 110
/** Units per call at most: few enough that each gets the model's attention. */
export const UNITS_PER_CALL = 6

/** A drafted question, ready to become a card once the student accepts it. */
export interface DeckQuestion {
  /** The card to create: `cloze` keeps its deletions in `front`. */
  kind: 'basic' | 'cloze'
  type: QuestionType
  difficulty: QuestionDifficulty
  front: string
  back: string
  /** The unit it is about (slide/page/section number), to group drafts by unit. */
  unit: number
  sourceRef: SourceRef
  /** Verbatim passage of the unit supporting the answer, when the model gave one that checks out. */
  quote?: string
}

export interface DeckQuestionsProgress {
  /** Questions kept per finished unit (possibly none). */
  done: Record<number, DeckQuestion[]>
}

export interface DeckQuestionsInput {
  /** The source the deck is filed as: every citation points at it. */
  sourceId: string
  units: readonly DeckUnitInput[]
  /** Questions per unit, 1 to `MAX_QUESTIONS_PER_UNIT`, or `auto` (the model decides, within that cap). */
  perUnit: QuestionCount
  /** At least one; default all. */
  types?: readonly QuestionType[]
  difficulty?: DifficultyMix
  courseTitle?: string
  deckTitle?: string
  /** Key notions from `readDeck`, so questions use the deck's terms. */
  notions?: readonly DeckNotion[]
  /** Texts of the course's existing cards (fronts, or front + back): near-duplicates are dropped. */
  existing?: readonly string[]
  /** The caller's own duplicate test (rejected drafts, drafts pending review elsewhere). */
  isDuplicate?: (q: DeckQuestion) => boolean
  /** False sends no image even to a vision model. */
  images?: boolean
  resume?: DeckQuestionsProgress
  onProgress?: (progress: DeckQuestionsProgress, finished: readonly number[]) => void
  feature?: AiFeature
}

export interface DeckQuestionsResult {
  /** In unit order. */
  questions: DeckQuestion[]
  byUnit: Map<number, DeckQuestion[]>
  /** Some units had images the model could not see. */
  textOnly: boolean
  /** Dropped as near-duplicates. */
  duplicates: number
  /** Dropped as malformed: unknown unit or type, cloze without deletion, empty side. */
  invalid: number
}

// ---------------------------------------------------------------------------------------------------------
// Duplicates

const CLOZE = /\{\{c\d+::(.*?)(?:::.*?)?\}\}/gs
const HAS_CLOZE = /\{\{c\d+::.+?\}\}/s
const WORD = /[\p{L}\p{N}]+/gu

/** Words of a card text, folded (case, accents), cloze markup reduced to its answers. */
export function cardWords(text: string): string[] {
  return (foldWord(text.replace(CLOZE, '$1')).match(WORD) ?? []).filter((w) => w.length > 1 || /\p{N}/u.test(w))
}

/** Share of shared distinct words (Jaccard). */
function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let common = 0
  for (const w of a) if (b.has(w)) common++
  return common / (a.size + b.size - common)
}

/** Near-duplicate threshold: same words in another order, or one word changed in a long question. */
export const DUPLICATE_SIMILARITY = 0.8

/**
 * Card texts to test new questions against: same words (folded, any order) or nearly so. Indexed by word,
 * so thousands of cards stay cheap.
 */
export class CardTextIndex {
  private readonly entries: Set<string>[] = []
  private readonly byWord = new Map<string, number[]>()

  constructor(texts: Iterable<string> = []) {
    for (const t of texts) this.add(t)
  }

  add(text: string): void {
    const words = new Set(cardWords(text))
    if (words.size === 0) return
    const id = this.entries.push(words) - 1
    for (const w of words) {
      const list = this.byWord.get(w)
      if (list) list.push(id)
      else this.byWord.set(w, [id])
    }
  }

  has(text: string): boolean {
    const words = new Set(cardWords(text))
    if (words.size === 0) return false
    const seen = new Set<number>()
    for (const w of words) {
      for (const id of this.byWord.get(w) ?? []) {
        if (seen.has(id)) continue
        seen.add(id)
        const other = this.entries[id]
        if (other && similarity(words, other) >= DUPLICATE_SIMILARITY) return true
      }
    }
    return false
  }
}

// ---------------------------------------------------------------------------------------------------------
// Prompt

const TYPE_RULES: Readonly<Record<QuestionType, string>> = {
  qa: '"qa": a precise question and its short answer.',
  cloze: '"cloze": one sentence from the material with the key term(s) hidden as {{c1::term}}; back is empty.',
  explain:
    '"explain": ask the student to explain an idea in their own words (« Explain in your own words … »); ' +
    'back is a model answer in a few sentences.',
}

const DIFFICULTY_RULES: Readonly<Record<DifficultyMix, string>> = {
  easy: 'Every question is "easy": recall of one fact or definition.',
  hard: 'Every question is "hard": application, comparison or reasoning across the unit.',
  mixed: 'Mix difficulties: about a third "easy" (recall), a third "medium" (understanding), a third "hard".',
}

function typesOf(input: DeckQuestionsInput): readonly QuestionType[] {
  const types = QUESTION_TYPES.filter((t) => input.types === undefined || input.types.includes(t))
  return types.length > 0 ? types : QUESTION_TYPES
}

/** Questions kept per unit at most. */
function perUnitCap(input: DeckQuestionsInput): number {
  return input.perUnit === 'auto' ? MAX_QUESTIONS_PER_UNIT : fixedQuestionCount(input.perUnit)
}

/** Questions expected per unit, for estimates and output limits. */
function perUnitOf(input: DeckQuestionsInput): number {
  return fixedQuestionCount(input.perUnit)
}

function countRule(input: DeckQuestionsInput): string {
  if (input.perUnit !== 'auto')
    return `For EACH unit, write exactly ${perUnitOf(input)} question(s) about that unit only, and set its "unit" to the unit's n.`
  return (
    `For EACH unit, decide how many questions it deserves, from 0 to ${MAX_QUESTIONS_PER_UNIT}, by how much there is ` +
    'to learn in it: none for a title, agenda, transition or thank-you unit, one or two for a single idea, more for ' +
    `a dense unit. Write them about that unit only, and set their "unit" to the unit's n.`
  )
}

function questionSystem(input: DeckQuestionsInput, language: string): string {
  const types = typesOf(input)
  return [
    'You write spaced-repetition questions on course material, unit by unit (a unit is a slide, a section or a page).',
    countRule(input),
    'Questions are atomic, unambiguous and answerable from the unit; never ask about the slide layout itself.',
    `Allowed types: ${types.map((t) => `"${t}"`).join(', ')}. Spread them across the questions.`,
    ...types.map((t) => TYPE_RULES[t]),
    DIFFICULTY_RULES[input.difficulty ?? 'mixed'],
    'When possible, add in "quote" a short passage copied verbatim from the unit that supports the answer.',
    'Do not repeat the questions listed under "Existing cards".',
    UNITS_RULE,
    `Write the questions and answers in ${language}.`,
  ].join('\n')
}

const MAX_EXISTING_IN_PROMPT = 40
const MAX_NOTIONS_IN_PROMPT = 30

function questionHead(input: DeckQuestionsInput): string {
  const lines: string[] = []
  if (input.courseTitle) lines.push(`Course: ${fence(input.courseTitle)}`)
  if (input.deckTitle) lines.push(`Material: ${fence(input.deckTitle)}`)
  const notions = (input.notions ?? []).slice(0, MAX_NOTIONS_IN_PROMPT)
  if (notions.length > 0)
    lines.push(`Key notions:\n${fence(notions.map((n) => `- ${n.term}: ${n.definition}`).join('\n'))}`)
  // A sample only: the full comparison happens in code.
  const existing = (input.existing ?? []).slice(0, MAX_EXISTING_IN_PROMPT)
  if (existing.length > 0)
    lines.push(`Existing cards:\n${fence(existing.map((e) => `- ${e.slice(0, 200)}`).join('\n'))}`)
  lines.push('Write the questions for these units.')
  return `${lines.join('\n')}\n`
}

function pending(input: DeckQuestionsInput): DeckUnitInput[] {
  return input.units.filter((u) => input.resume?.done[u.index] === undefined)
}

function questionPlan(info: CatalogModel, input: DeckQuestionsInput): { vision: boolean; batches: DeckBatch[] } {
  const vision = input.images !== false && supportsImages(info)
  const batches = planDeckBatches(pending(input), info, {
    overheadTokens: estimateTokens(questionSystem(input, 'English') + questionHead(input)),
    // Room for the most a unit may get, so a dense unit is never cut short.
    outputTokensPerUnit: perUnitCap(input) * QUESTION_OUTPUT_TOKENS,
    maxUnits: UNITS_PER_CALL,
    vision,
  })
  return { vision, batches }
}

export interface DeckQuestionsEstimate extends CostEstimate {
  batches: number
  /** Units whose images will not be seen (text-only model, or images turned off). */
  imagesUnseen: number
  /** Cost of each pending unit with its share of its batch's prompt, to price a range of slides. */
  units: { index: number; cost: number }[]
}

/** Cost of `deckQuestions` before running it; units already in `resume` cost nothing. */
export function estimateDeckQuestionsCost(info: CatalogModel, input: DeckQuestionsInput): DeckQuestionsEstimate {
  const { vision, batches } = questionPlan(info, input)
  const overhead = estimateTokens(questionSystem(input, 'English') + questionHead(input))
  const perUnitOut = perUnitOf(input) * QUESTION_OUTPUT_TOKENS
  let inputTokens = 0
  let outputTokens = 0
  const units: { index: number; cost: number }[] = []
  for (const b of batches) {
    inputTokens += overhead + b.tokens
    outputTokens += b.units.length * perUnitOut
    for (const u of b.units) {
      const share = { inputTokens: overhead / b.units.length + unitTokens(u, vision), outputTokens: perUnitOut }
      units.push({ index: u.index, cost: estimateCost(share, 0, info.cost).cost })
    }
  }
  return {
    ...estimateCost({ inputTokens, outputTokens }, batches.length, info.cost),
    batches: batches.length,
    imagesUnseen: unseenImages(pending(input), vision),
    units,
  }
}

// ---------------------------------------------------------------------------------------------------------
// Run

const squash = (s: string): string => foldWord(s).replace(/\s+/g, ' ').trim()

/** The quote, when it really appears in the unit (case, accents and spacing aside). */
function verifiedQuote(quote: string | undefined, unit: DeckUnitInput): string | undefined {
  const q = quote?.trim()
  if (!q) return undefined
  const haystack = squash([unit.title, unit.text, unit.notes ?? ''].join('\n'))
  return haystack.includes(squash(q)) ? q : undefined
}

/** A drafted question checked and shaped as a card, or null when malformed. */
function toQuestion(
  d: DeckQuestionDraft,
  unit: DeckUnitInput | undefined,
  types: readonly QuestionType[],
  sourceId: string,
): DeckQuestion | null {
  if (!unit || !types.includes(d.type)) return null
  const front = d.front.trim()
  const back = d.back.trim()
  if (front === '') return null
  if (d.type === 'cloze' ? !HAS_CLOZE.test(front) : back === '') return null
  const q: DeckQuestion = {
    kind: d.type === 'cloze' ? 'cloze' : 'basic',
    type: d.type,
    difficulty: d.difficulty,
    front,
    back: d.type === 'cloze' ? '' : back,
    unit: unit.index,
    sourceRef: { sourceId, page: unit.index },
  }
  const quote = verifiedQuote(d.quote, unit)
  if (quote) q.quote = quote
  return q
}

/** Questions for each unit, batch by batch; see the module comment. */
export async function deckQuestions(ctx: FeatureCtx, input: DeckQuestionsInput): Promise<DeckQuestionsResult> {
  const { vision, batches } = questionPlan(ctx.info, input)
  const types = typesOf(input)
  const perUnit = perUnitCap(input)
  const done: Record<number, DeckQuestion[]> = { ...input.resume?.done }
  const index = new CardTextIndex(input.existing)
  for (const list of Object.values(done)) for (const q of list) index.add(q.front)
  let duplicates = 0
  let invalid = 0
  for (const batch of batches) {
    ctx.signal?.throwIfAborted()
    const byIndex = new Map(batch.units.map((u) => [u.index, u]))
    const out = await askDeck(ctx, {
      feature: input.feature ?? 'generateCards',
      system: questionSystem(input, ctx.language),
      prompt: questionHead(input),
      units: batch.units,
      vision,
      schema: deckQuestionsSchema,
    })
    const kept = new Map<number, DeckQuestion[]>(batch.units.map((u) => [u.index, []]))
    for (const draft of out.questions) {
      const q = toQuestion(draft, byIndex.get(draft.unit), types, input.sourceId)
      const list = q ? kept.get(q.unit) : undefined
      if (!q || !list) {
        invalid++
        continue
      }
      if (list.length >= perUnit) continue
      if (index.has(q.front) || input.isDuplicate?.(q) === true) {
        duplicates++
        continue
      }
      index.add(q.front)
      list.push(q)
    }
    for (const [unit, list] of kept) done[unit] = list
    input.onProgress?.({ done: { ...done } }, batchKey(batch).split(',').map(Number))
  }
  const byUnit = new Map<number, DeckQuestion[]>()
  const questions: DeckQuestion[] = []
  for (const u of input.units) {
    const list = done[u.index] ?? []
    byUnit.set(u.index, list)
    questions.push(...list)
  }
  return { questions, byUnit, textOnly: unseenImages(input.units, vision) > 0, duplicates, invalid }
}
