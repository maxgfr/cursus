import type {
  Card,
  CardInput,
  Course,
  CourseInput,
  Fiche,
  FicheInput,
  Id,
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
  reviews: 'reviews',
  aiUsage: 'aiUsage',
  prefs: 'prefs',
} as const

/** Collections the search indexes (sections are reached through the path of their items). */
export type EntityCollection = 'courses' | 'sources' | 'fiches' | 'cards'
/** Every top-level collection of entities (Y.Map of scalars). */
export type RepoCollection = EntityCollection | 'sections'
export type TextField = 'body' | 'front' | 'back'

/** Y.Text fields each entity kind owns, created inside its creation transaction. */
export const TEXT_FIELDS: Record<RepoCollection, readonly TextField[]> = {
  courses: [],
  sections: [],
  sources: ['body'],
  fiches: ['body'],
  cards: ['front', 'back'],
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

export interface SourceFields extends SourceInput {
  blobIds?: string[]
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
}
export interface CardRecord extends Card, CardFields {}

/** Compact AI usage event; `voids` undoes a previous event. */
export type AiUsageEvent =
  | { id: Id; at: number; model: string; inTok: number; outTok: number; dev: string }
  | { id: Id; voids: Id }

/** Defaults live in code; the doc only holds values the user explicitly set. */
export const PREF_DEFAULTS: Prefs = {
  locale: 'en',
  theme: 'system',
  dailyNewCards: 20,
  desiredRetention: 0.9,
}
