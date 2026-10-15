import type {
  Card,
  CardInput,
  Course,
  CourseInput,
  Fiche,
  FicheInput,
  Id,
  NewSession,
  Plan,
  PlanInput,
  Prefs,
  Section,
  SectionInput,
  Source,
  SourceInput,
} from '../contracts/workspace'

/** Top-level collection names. These are the ONLY root types of the doc. */
export const ROOT = {
  courses: 'courses',
  sections: 'sections',
  sources: 'sources',
  fiches: 'fiches',
  cards: 'cards',
  texts: 'texts',
  /** Legacy review log: one object per event. Still read, never written again (`reviewLog` replaces it). */
  reviews: 'reviews',
  /**
   * Review log: one compact string per event (see reviewCodec.ts). An earlier build reads only `reviews`: every
   * segment this build writes is envelope version 2 (codec.ts), which such a build keeps as needs-upgrade
   * instead of scheduling without these reviews.
   */
  reviewLog: 'reviewLog',
  aiUsage: 'aiUsage',
  prefs: 'prefs',
  sessions: 'sessions',
  plans: 'plans',
  /** Proposed questions awaiting review (see drafts.ts); rejected ones stay as tombstones forever. */
  drafts: 'drafts',
} as const

/** Collections the search indexes (sections are reached through the path of their items). */
export type EntityCollection = 'courses' | 'sources' | 'fiches' | 'cards'
/** Every top-level collection of entities (Y.Map of scalars). */
export type RepoCollection = EntityCollection | 'sections' | 'plans' | 'drafts'
export type TextField = 'body' | 'front' | 'back'

/** Y.Text fields each entity kind owns, created inside its creation transaction. */
export const TEXT_FIELDS: Record<RepoCollection, readonly TextField[]> = {
  courses: [],
  sections: [],
  sources: ['body'],
  fiches: ['body'],
  cards: ['front', 'back'],
  plans: [],
  drafts: [],
}

export function textKey(id: Id, field: TextField): string {
  return `${id}/${field}`
}

// Complete schema: the contract inputs plus model-level optional fields.
export interface CourseFields extends CourseInput {
  emoji?: string
  language?: string
  examDate?: string
}
export interface CourseRecord extends Course, CourseFields {}

export type SectionFields = SectionInput
export interface SectionRecord extends Section, SectionFields {}

/**
 * How an imported slide deck or structured document is read: by slide/page (`deck`) or by section (`document`).
 * Additive: `kind` stays one older clients know (`pdf` for a PDF, `note` for .pptx/.docx), `blobId` holds the
 * original file and `blobIds` its images as `cursus-blob:<h64>` (so the creating segment lists them in `blobRefs`);
 * the extracted text is a local, recomputable cache, never in the doc.
 */
export type SourceSupport = 'deck' | 'document'
export interface SourceFields extends SourceInput {
  blobIds?: string[]
  support?: SourceSupport
  /**
   * Photos (`kind: 'image'`): `cursus-blob:<h64>` of the stored file, so the segment creating the photo lists it in
   * `blobRefs` and is never sent before its file (sync closure). `blobId` holds the same id, bare.
   */
  photo?: string
  caption?: string
  /** Clockwise quarter turns applied when shown (0, 90, 180, 270); the stored file is never rewritten. */
  rotation?: number
  /** The note or PDF a photo belongs to. */
  attachedTo?: Id
  width?: number
  height?: number
}
export interface SourceRecord extends Source, SourceFields {}

export interface KeyPoint {
  text: string
  sourceRef?: { sourceId: Id; page?: number; quote?: string }
}
export interface FicheFields extends FicheInput {
  subject?: string
  keyPoints?: KeyPoint[]
  template?: string
}
export interface FicheRecord extends Fiche, FicheFields {}

export type CardOrigin = 'manual' | 'ai' | 'anki' | 'cloze'
export interface CardFields extends CardInput {
  sourceId?: Id
  tags?: string[]
  origin?: CardOrigin
  suspended?: boolean
  ankiGuid?: string
  /** Provenance of a card accepted from a proposed question: the draft, and the unit of `sourceId` it cites. */
  draftId?: Id
  unit?: number
}
export interface CardRecord extends Card, CardFields {}

export type DraftQuestionType = 'qa' | 'cloze' | 'explain'
export type DraftDifficulty = 'easy' | 'medium' | 'hard'
export type DraftUnitKind = 'slide' | 'page' | 'section'

/**
 * A proposed question (Y.Map of scalars in `drafts`). Its state is spread over separate keys so concurrent
 * actions merge instead of overwriting each other: `cardId` (accepted), `rejectedAt` (rejected). Nothing ever
 * removes `rejectedAt`, so an edit made elsewhere at the same time cannot bring a rejected question back.
 * Older clients ignore the collection.
 */
export interface DraftFields {
  sourceId: Id
  /** Where the card goes once accepted (a course, or one of its subsets). */
  courseId: Id
  sectionId?: Id
  /** The unit of the source it is about (slide/page/section number, 1-based; 0 = the whole source). */
  unit: number
  unitKind?: DraftUnitKind
  unitLabel?: string
  kind: 'basic' | 'cloze'
  type: DraftQuestionType
  difficulty?: DraftDifficulty
  front: string
  back: string
  /** Verbatim passage of the unit supporting the answer. */
  quote?: string
  /** The question as the model wrote it: kept through edits, so a rejected question is recognised again. */
  proposed: string
  /** `provider/model` that wrote it. */
  model?: string
  rejectedAt?: number
  acceptedAt?: number
  cardId?: Id
}
export interface DraftRecord extends DraftFields {
  id: Id
  createdAt: number
  updatedAt: number
  deletedAt?: number
  purgedAt?: number
}

/** Compact AI usage event; `voids` undoes a previous event. */
export type AiUsageEvent =
  | {
      id: Id
      at: number
      model: string
      inTok: number
      outTok: number
      dev: string
      /** The source the tokens were spent on, when there is one (additive: older events have none). */
      src?: Id
    }
  | { id: Id; voids: Id }

export type PlanFields = PlanInput
export interface PlanRecord extends Plan, PlanFields {}

/**
 * Session log events: a start, then (maybe) an end appended later — never a rewrite. Several devices may end the
 * same session: the earliest end wins.
 */
export type SessionStartEvent = NewSession & { id: Id; startedAt: number; dev: string }
export type SessionEndEvent = { id: Id; ends: Id; endedAt: number }
export type SessionEvent = SessionStartEvent | SessionEndEvent

/** Defaults live in code; the doc only holds values the user explicitly set. */
export const PREF_DEFAULTS: Prefs = {
  locale: 'en',
  theme: 'system',
  dailyNewCards: 20,
  desiredRetention: 0.9,
}
