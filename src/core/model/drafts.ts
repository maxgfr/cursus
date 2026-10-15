import type * as Y from 'yjs'
import type { Id, StudyScope } from '../contracts/workspace'
import { EntityNotFoundError, EntityRepo, type RepoDeps } from './repos'
import {
  type CardFields,
  type CourseRecord,
  type DraftDifficulty,
  type DraftFields,
  type DraftQuestionType,
  type DraftRecord,
  type DraftUnitKind,
  ROOT,
  type SourceRecord,
} from './schema'
import type { SectionTree } from './sections'

/**
 * Proposed questions (« À relire »): drafts of cards written by the AI on a source, grouped by source and unit
 * (slide, page, section), reviewed before anything enters spaced repetition.
 *
 * - `accept` creates the card in the draft's course or subset and marks the draft accepted, all or nothing.
 * - `reject` is final: the draft stays forever as a tombstone, so the same question is never proposed again
 *   (`rejectedTexts`, `isRejected`), and nothing done elsewhere at the same time brings it back. There is no
 *   unreject (a concurrent one could erase another device's rejection): an « Annuler » belongs before the write.
 * - Drafts of a trashed source, or bound for a trashed course, are hidden by derivation (no cascade write).
 *
 * A draft accepted on two devices before they sync gives two cards (both kept: nothing is lost); its
 * `cardId` then names one of them, the same everywhere.
 */

export type DraftStatus = 'proposed' | 'accepted' | 'rejected'
export interface Draft extends DraftRecord {
  status: DraftStatus
}

/** What a run proposes; the model's text is kept as `proposed`. */
export interface NewDraft {
  sourceId: Id
  courseId: Id
  sectionId?: Id
  unit: number
  unitKind?: DraftUnitKind
  unitLabel?: string
  kind: 'basic' | 'cloze'
  type: DraftQuestionType
  difficulty?: DraftDifficulty
  front: string
  back: string
  quote?: string
  model?: string
}

export type DraftEdit = Partial<Pick<DraftFields, 'front' | 'back' | 'kind' | 'type' | 'courseId' | 'sectionId'>>

export interface DraftUnitGroup {
  unit: number
  unitKind?: DraftUnitKind
  unitLabel?: string
  drafts: readonly Draft[]
}
export interface DraftSourceGroup {
  sourceId: Id
  /** Proposed drafts of the source. */
  count: number
  units: readonly DraftUnitGroup[]
}

/** Proposed drafts per source, newest activity first: what the Today line says. */
export interface DraftSummary {
  total: number
  sources: readonly { sourceId: Id; courseId: Id; count: number; latestAt: number }[]
}

export class DraftInputError extends RangeError {
  constructor(m: string) {
    super(m)
    this.name = 'DraftInputError'
  }
}

/** The action needs a proposed draft (an accepted draft is edited as its card; a rejection is final). */
export class DraftStateError extends Error {
  constructor(
    readonly id: Id,
    readonly status: DraftStatus,
  ) {
    super(`draft ${id} is ${status}`)
    this.name = 'DraftStateError'
  }
}

export function draftStatus(d: Pick<DraftFields, 'cardId' | 'rejectedAt'>): DraftStatus {
  if (d.cardId !== undefined) return 'accepted'
  if (d.rejectedAt !== undefined) return 'rejected'
  return 'proposed'
}

const CLOZE = /\{\{c\d+::(.*?)(?:::.*?)?\}\}/gs
const HAS_CLOZE = /\{\{c\d+::.+?\}\}/s

/** A question folded for exact comparison: cloze markup reduced to its answers, case, accents and punctuation aside. */
export function questionKey(text: string): string {
  return text
    .replace(CLOZE, '$1')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const TYPES: readonly DraftQuestionType[] = ['qa', 'cloze', 'explain']
const DIFFICULTIES: readonly DraftDifficulty[] = ['easy', 'medium', 'hard']
const UNIT_KINDS: readonly DraftUnitKind[] = ['slide', 'page', 'section']

function checkShape(p: Partial<DraftFields>): void {
  if (p.front !== undefined && p.front.trim() === '') throw new DraftInputError('a question needs a front')
  if (p.kind !== undefined && p.kind !== 'basic' && p.kind !== 'cloze')
    throw new DraftInputError(`unknown card kind ${String(p.kind)}`)
  if (p.type !== undefined && !TYPES.includes(p.type)) throw new DraftInputError(`unknown type ${String(p.type)}`)
  if (p.difficulty !== undefined && !DIFFICULTIES.includes(p.difficulty))
    throw new DraftInputError(`unknown difficulty ${String(p.difficulty)}`)
  if (p.unitKind !== undefined && !UNIT_KINDS.includes(p.unitKind))
    throw new DraftInputError(`unknown unit kind ${String(p.unitKind)}`)
  if (p.unit !== undefined && (!Number.isInteger(p.unit) || p.unit < 0))
    throw new DraftInputError(`invalid unit ${p.unit}`)
  if (p.courseId !== undefined && p.courseId === '') throw new DraftInputError('a draft needs a course')
}

/** Cloze drafts must keep a deletion, whichever field changed. */
function checkCloze(kind: 'basic' | 'cloze', front: string): void {
  if (kind === 'cloze' && !HAS_CLOZE.test(front)) throw new DraftInputError('a cloze question needs {{c1::…}}')
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const byUnit = (a: Draft, b: Draft): number => cmp(a.sourceId, b.sourceId) || a.unit - b.unit || cmp(a.id, b.id)

// ---------------------------------------------------------------------------------------------------------
// Settings

export type AutoQuestionMode = 'propose' | 'add' | 'off'
export type AutoQuestionDifficulty = 'easy' | 'mixed' | 'hard'
/** `course`: the course's language (else the interface's). */
export type AutoQuestionLanguage = 'course' | 'en' | 'de' | 'fr'

/**
 * « Quand j'ajoute un document » and its folded advanced settings. Synced (one choice for every device): the
 * mode is a preference, and the caps bound what the student spends in all, the monthly usage being synced too.
 * Defaults live here; a value is written only when the student changes it.
 */
export interface AutoQuestionSettings {
  mode: AutoQuestionMode
  /** Questions per slide, page or section; `auto` lets the model decide by density, up to the cap. */
  perUnit: AutoQuestionCount
  types: readonly DraftQuestionType[]
  difficulty: AutoQuestionDifficulty
  language: AutoQuestionLanguage
  /** Drop questions close to the course's existing cards (rejected questions are always dropped). */
  dedupe: boolean
  /** Where accepted cards go; absent (or no longer there) = the source's own course or subset. */
  destination?: StudyScope
  /** USD a single document may cost. */
  capPerDocument: number
  /** USD all automatic and manual AI use may cost in a calendar month (this device's runs stop there). */
  capPerMonth: number
}

/**
 * A number of questions per unit, or `auto`. Stored as is in the synced prefs: a version that knows only numbers
 * reads `auto` as invalid and uses its own default, and a number stored by such a version is still read here.
 */
export type AutoQuestionCount = number | 'auto'
export const AUTO_QUESTION_MAX_PER_UNIT = 10
export const AUTO_QUESTION_DEFAULTS: AutoQuestionSettings = {
  mode: 'propose',
  perUnit: 'auto',
  types: ['qa', 'cloze'],
  difficulty: 'mixed',
  language: 'course',
  dedupe: true,
  capPerDocument: 0.2,
  capPerMonth: 2,
}

type SettingKey = keyof AutoQuestionSettings
const SETTING_KEYS: readonly SettingKey[] = [
  'mode',
  'perUnit',
  'types',
  'difficulty',
  'language',
  'dedupe',
  'destination',
  'capPerDocument',
  'capPerMonth',
]
const prefKey = (k: SettingKey): string => `autoQuestions.${k}`

const MODES: readonly AutoQuestionMode[] = ['propose', 'add', 'off']
const MIXES: readonly AutoQuestionDifficulty[] = ['easy', 'mixed', 'hard']
const LANGUAGES: readonly AutoQuestionLanguage[] = ['course', 'en', 'de', 'fr']

const isCap = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Whether a stored or given value is valid for the setting. */
function validSetting(k: SettingKey, v: unknown): boolean {
  switch (k) {
    case 'mode':
      return MODES.includes(v as AutoQuestionMode)
    case 'perUnit':
      return v === 'auto' || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= AUTO_QUESTION_MAX_PER_UNIT)
    case 'types':
      return Array.isArray(v) && v.length > 0 && v.every((t) => TYPES.includes(t)) && new Set(v).size === v.length
    case 'difficulty':
      return MIXES.includes(v as AutoQuestionDifficulty)
    case 'language':
      return LANGUAGES.includes(v as AutoQuestionLanguage)
    case 'dedupe':
      return typeof v === 'boolean'
    case 'destination': {
      if (typeof v !== 'object' || v === null) return false
      const s = v as Record<string, unknown>
      return (
        typeof s.courseId === 'string' &&
        s.courseId !== '' &&
        (s.sectionId === undefined || (typeof s.sectionId === 'string' && s.sectionId !== ''))
      )
    }
    case 'capPerDocument':
    case 'capPerMonth':
      return isCap(v)
  }
}

/** Settings over the synced prefs map, one key per setting so changes made on two devices both survive. */
export class AutoQuestionPrefs {
  constructor(
    private readonly doc: Y.Doc,
    private readonly prefs: Y.Map<unknown>,
  ) {}

  /** Every setting, defaults for those never set or written by a version this one does not understand. */
  get(): AutoQuestionSettings {
    const out: AutoQuestionSettings = { ...AUTO_QUESTION_DEFAULTS }
    const target = out as unknown as Record<string, unknown>
    for (const k of SETTING_KEYS) {
      const v = this.prefs.get(prefKey(k))
      // Copies: the stored array or object must never be changed in place by a caller.
      if (v !== undefined && validSetting(k, v))
        target[k] = Array.isArray(v) ? [...v] : typeof v === 'object' && v !== null ? { ...v } : v
    }
    return out
  }

  /** Writes the given settings (explicit action only); `undefined` puts one back to its default. */
  set(patch: Partial<AutoQuestionSettings>): void {
    const entries = Object.entries(patch) as [SettingKey, unknown][]
    for (const [k, v] of entries) {
      if (!SETTING_KEYS.includes(k)) throw new DraftInputError(`unknown setting ${String(k)}`)
      if (v !== undefined && !validSetting(k, v)) throw new DraftInputError(`invalid ${k}: ${JSON.stringify(v)}`)
    }
    this.doc.transact(() => {
      for (const [k, v] of entries) {
        if (v === undefined) this.prefs.delete(prefKey(k))
        else if (k === 'types') this.prefs.set(prefKey(k), [...(v as DraftQuestionType[])])
        else if (k === 'destination') {
          const d = v as StudyScope
          this.prefs.set(prefKey(k), d.sectionId === undefined ? { courseId: d.courseId } : { ...d })
        } else this.prefs.set(prefKey(k), v)
      }
    })
  }
}

// ---------------------------------------------------------------------------------------------------------
// Repo

/** What drafts need from the rest of the workspace (every write still goes through its repos). */
export interface DraftHost {
  courses: { get(id: Id): CourseRecord | undefined }
  sources: { get(id: Id): SourceRecord | undefined }
  sections: { tree(): SectionTree }
  cards: { create(i: CardFields): Id }
  text(ref: { id: Id; field: 'front' | 'back' }): Y.Text
  atomic<T>(fn: () => T): T
}

export class DraftRepo {
  private readonly repo: EntityRepo<DraftRecord, DraftFields>
  private readonly derived = new WeakMap<DraftRecord, Draft>()
  private allMemo: { src: readonly DraftRecord[]; out: readonly Draft[] } | null = null
  readonly settings: AutoQuestionPrefs

  constructor(
    private readonly deps: RepoDeps,
    private readonly host: DraftHost,
  ) {
    this.repo = new EntityRepo<DraftRecord, DraftFields>(deps, 'drafts')
    this.settings = new AutoQuestionPrefs(deps.doc, deps.doc.getMap<unknown>(ROOT.prefs))
  }

  get yRoot(): Y.Map<Y.Map<unknown>> {
    return this.repo.yRoot
  }

  private withStatus(r: DraftRecord): Draft {
    const memo = this.derived.get(r)
    if (memo) return memo
    const d: Draft = { ...r, status: draftStatus(r) }
    this.derived.set(r, d)
    return d
  }

  /** Every draft ever written, tombstones and hidden ones included, by id; the same array while nothing changes. */
  all(): readonly Draft[] {
    const src = this.repo.all()
    if (this.allMemo?.src !== src) this.allMemo = { src, out: src.map((r) => this.withStatus(r)) }
    return this.allMemo.out
  }

  get(id: Id): Draft | undefined {
    const r = this.repo.get(id)
    return r ? this.withStatus(r) : undefined
  }

  private sourceLive(id: Id): boolean {
    const s = this.host.sources.get(id)
    return s !== undefined && s.deletedAt === undefined && !this.host.sections.tree().itemHidden(s)
  }

  private courseLive(id: Id): boolean {
    const c = this.host.courses.get(id)
    return c !== undefined && c.deletedAt === undefined
  }

  /** Shown to the student: its source is live and its course is not in the trash. */
  visible(d: Pick<DraftFields, 'sourceId' | 'courseId'>): boolean {
    return this.sourceLive(d.sourceId) && this.courseLive(d.courseId)
  }

  /** Visible drafts (proposed only unless `status` says otherwise), by source, unit, then id. */
  list(f?: { sourceId?: Id; courseId?: Id; unit?: number; status?: DraftStatus | 'all' }): readonly Draft[] {
    const status = f?.status ?? 'proposed'
    return this.all()
      .filter(
        (d) =>
          (status === 'all' || d.status === status) &&
          (f?.sourceId === undefined || d.sourceId === f.sourceId) &&
          (f?.courseId === undefined || d.courseId === f.courseId) &&
          (f?.unit === undefined || d.unit === f.unit) &&
          this.visible(d),
      )
      .sort(byUnit)
  }

  /** Proposed drafts grouped by source, then unit (slide, page, section): the review screen. */
  groups(f?: { sourceId?: Id; courseId?: Id }): DraftSourceGroup[] {
    const bySource = new Map<Id, Map<number, Draft[]>>()
    for (const d of this.list(f)) {
      const units = bySource.get(d.sourceId) ?? new Map<number, Draft[]>()
      bySource.set(d.sourceId, units)
      const list = units.get(d.unit)
      if (list) list.push(d)
      else units.set(d.unit, [d])
    }
    return [...bySource].map(([sourceId, units]) => ({
      sourceId,
      count: [...units.values()].reduce((n, l) => n + l.length, 0),
      units: [...units].map(([unit, drafts]) => {
        const first = drafts[0]
        const g: DraftUnitGroup = { unit, drafts }
        if (first?.unitKind !== undefined) g.unitKind = first.unitKind
        if (first?.unitLabel !== undefined) g.unitLabel = first.unitLabel
        return g
      }),
    }))
  }

  /** Proposed drafts per source: « 12 questions proposées depuis Physiologie ». */
  summary(): DraftSummary {
    const bySource = new Map<Id, { sourceId: Id; courseId: Id; count: number; latestAt: number }>()
    for (const d of this.list()) {
      const s = bySource.get(d.sourceId)
      if (s) {
        s.count++
        s.latestAt = Math.max(s.latestAt, d.createdAt)
      } else bySource.set(d.sourceId, { sourceId: d.sourceId, courseId: d.courseId, count: 1, latestAt: d.createdAt })
    }
    const sources = [...bySource.values()].sort((a, b) => b.latestAt - a.latestAt || cmp(a.sourceId, b.sourceId))
    return { total: sources.reduce((n, s) => n + s.count, 0), sources }
  }

  /** Texts of every rejected question (as proposed and as last edited): never to be proposed again. */
  rejectedTexts(): string[] {
    const out: string[] = []
    for (const d of this.all()) {
      if (d.rejectedAt === undefined) continue
      out.push(d.proposed)
      if (d.front !== d.proposed) out.push(d.front)
    }
    return out
  }

  /** Was this question (case, accents and punctuation aside) rejected before? */
  isRejected(front: string): boolean {
    const key = questionKey(front)
    if (key === '') return false
    return this.all().some(
      (d) => d.rejectedAt !== undefined && (questionKey(d.proposed) === key || questionKey(d.front) === key),
    )
  }

  /** Writes proposed drafts in one transaction; returns their ids in order. */
  propose(drafts: readonly NewDraft[]): Id[] {
    for (const d of drafts) {
      checkShape(d)
      if (d.sourceId === '') throw new DraftInputError('a draft needs a source')
      checkCloze(d.kind, d.front)
    }
    if (drafts.length === 0) return []
    const ids: Id[] = []
    this.deps.doc.transact(() => {
      for (const d of drafts) {
        const fields: DraftFields = {
          sourceId: d.sourceId,
          courseId: d.courseId,
          unit: d.unit,
          kind: d.kind,
          type: d.type,
          front: d.front.trim(),
          back: d.back.trim(),
          proposed: d.front.trim(),
        }
        if (d.sectionId !== undefined) fields.sectionId = d.sectionId
        if (d.unitKind !== undefined) fields.unitKind = d.unitKind
        if (d.unitLabel !== undefined) fields.unitLabel = d.unitLabel
        if (d.difficulty !== undefined) fields.difficulty = d.difficulty
        if (d.quote !== undefined && d.quote.trim() !== '') fields.quote = d.quote.trim()
        if (d.model !== undefined) fields.model = d.model
        ids.push(this.repo.create(fields))
      }
    })
    return ids
  }

  private draft(id: Id): Draft {
    const d = this.get(id)
    if (!d) throw new EntityNotFoundError('drafts', id)
    return d
  }

  private proposed(id: Id): Draft {
    const d = this.draft(id)
    if (d.status !== 'proposed') throw new DraftStateError(id, d.status)
    return d
  }

  /** Changes a proposed draft: its text, kind, type or destination. */
  edit(id: Id, patch: DraftEdit): void {
    const d = this.proposed(id)
    checkShape(patch)
    const kind = patch.kind ?? d.kind
    checkCloze(kind, patch.front ?? d.front)
    const p: Partial<DraftFields> = {}
    if (patch.front !== undefined) p.front = patch.front.trim()
    if (patch.back !== undefined) p.back = patch.back.trim()
    if (patch.kind !== undefined) p.kind = patch.kind
    if (patch.type !== undefined) p.type = patch.type
    if (patch.courseId !== undefined) {
      p.courseId = patch.courseId
      // Another course: the subset no longer applies unless given with it.
      if (!('sectionId' in patch)) p.sectionId = undefined
    }
    if ('sectionId' in patch) p.sectionId = patch.sectionId
    this.repo.update(id, p)
  }

  /** Where the card of `d` goes: `to`, else the draft's own; a subset no longer usable falls back to its course. */
  private destination(d: Draft, to?: StudyScope): StudyScope {
    const courseId = to?.courseId ?? d.courseId
    if (!this.courseLive(courseId)) throw new EntityNotFoundError('courses', courseId)
    const sectionId = to ? to.sectionId : d.sectionId
    if (sectionId === undefined) return { courseId }
    const tree = this.host.sections.tree()
    const s = tree.get(sectionId)
    return s !== undefined && s.courseId === courseId && !tree.hidden(sectionId)
      ? { courseId, sectionId }
      : { courseId }
  }

  private acceptOne(id: Id, to?: StudyScope): Id {
    const d = this.proposed(id)
    const scope = this.destination(d, to)
    const card: CardFields = {
      courseId: scope.courseId,
      kind: d.kind,
      sourceId: d.sourceId,
      origin: 'ai',
      draftId: d.id,
      unit: d.unit,
    }
    if (scope.sectionId !== undefined) card.sectionId = scope.sectionId
    const cardId = this.host.cards.create(card)
    this.host.text({ id: cardId, field: 'front' }).insert(0, d.front)
    if (d.back !== '') this.host.text({ id: cardId, field: 'back' }).insert(0, d.back)
    this.repo.update(id, { cardId, acceptedAt: this.deps.clock.now() })
    return cardId
  }

  /** Creates the card (with its provenance) and marks the draft accepted, all or nothing; returns the card id. */
  accept(id: Id, to?: StudyScope): Id {
    return this.host.atomic(() => this.acceptOne(id, to))
  }

  /** Accepts every given draft that is still proposed, all or nothing; returns the new card ids. */
  acceptAll(ids: readonly Id[], to?: StudyScope): Id[] {
    return this.host.atomic(() =>
      ids.filter((id) => this.get(id)?.status === 'proposed').map((id) => this.acceptOne(id, to)),
    )
  }

  /** Rejects a draft for good: it stays as a tombstone so the question is never proposed again. */
  reject(id: Id): void {
    const d = this.draft(id)
    if (d.status === 'accepted') throw new DraftStateError(id, d.status)
    if (d.rejectedAt === undefined) this.repo.update(id, { rejectedAt: this.deps.clock.now() })
  }

  rejectAll(ids: readonly Id[]): void {
    this.deps.doc.transact(() => {
      for (const id of ids) if (this.get(id)?.status === 'proposed') this.reject(id)
    })
  }
}
