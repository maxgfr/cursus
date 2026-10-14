import type * as Y from 'yjs'

export type Id = string

interface EntityMeta {
  id: Id
  createdAt: number
  updatedAt: number
  deletedAt?: number
  purgedAt?: number
}
export interface CourseInput {
  title: string
  color?: string
  order?: string
}
export interface Course extends EntityMeta, CourseInput {}
/** Where an item lives: absent `sectionId` = the course root. */
interface Placed {
  sectionId?: Id
}
/** A subset of a course (chapter, section…), freely nested. Absent `parentId` = the course root. */
export interface SectionInput {
  courseId: Id
  parentId?: Id
  name: string
  /** Fractional index among its siblings. */
  order?: string
  /** ISO `YYYY-MM-DD` of this subset's own exam. */
  examDate?: string
}
export interface Section extends EntityMeta, SectionInput {}
/** Collections whose entities can be placed in a section. */
export type ItemKind = 'sources' | 'fiches' | 'cards'
/** A course, or one of its subsets with all its descendants. */
export interface StudyScope {
  courseId: Id
  sectionId?: Id
}
export interface SourceInput extends Placed {
  courseId: Id
  kind: 'note' | 'pdf' | 'image'
  title: string
  blobId?: string
}
export interface Source extends EntityMeta, SourceInput {}
export interface FicheInput extends Placed {
  courseId: Id
  title: string
  sourceIds?: Id[]
}
export interface Fiche extends EntityMeta, FicheInput {}
export interface CardInput extends Placed {
  courseId: Id
  ficheId?: Id
  kind: 'basic' | 'cloze'
}
export interface Card extends EntityMeta, CardInput {}
export type Rating = 1 | 2 | 3 | 4
export interface NewReview {
  cardId: Id
  rating: Rating
  at: number
  ms: number
}
export type Review = (NewReview & { id: Id; dev: string }) | { id: Id; voids: Id }
export interface Prefs {
  locale: 'en' | 'de' | 'fr'
  theme: 'system' | 'light' | 'dark'
  dailyNewCards: number
  desiredRetention: number
}
export type Scope = 'courses' | 'sections' | 'sources' | 'fiches' | 'cards' | 'reviews' | 'prefs' | { id: Id }

export interface Repo<T, In> {
  list(f?: { courseId?: Id; trashed?: boolean }): readonly T[]
  get(id: Id): T | undefined
  create(i: In): Id
  update(id: Id, p: Partial<In>): void
  trash(id: Id): void
  restore(id: Id): void
  purge(id: Id): void
}
export interface Workspace {
  // le SEUL module qui touche à Yjs
  courses: Repo<Course, CourseInput>
  sources: Repo<Source, SourceInput>
  fiches: Repo<Fiche, FicheInput>
  cards: Repo<Card, CardInput> & { move(id: Id, courseId: Id): void }
  /**
   * Subsets. `move` refuses a parent inside the section's own subtree or in another course; `path` is the chain
   * from the course root down to the section (itself included); `subtree` is the section and every descendant.
   * Concurrent moves that form a cycle are resolved at read time, identically everywhere, without any write.
   */
  sections: Repo<Section, SectionInput> & {
    move(id: Id, parentId: Id | null): void
    path(id: Id): readonly Section[]
    subtree(id: Id): readonly Id[]
  }
  /** Places a source, fiche or card in a section (its course follows), or at its course root with null. */
  moveItem(kind: ItemKind, id: Id, sectionId: Id | null): void
  reviews: { record(r: NewReview): Id; void(id: Id): void; forCard(id: Id): readonly Review[] }
  prefs: { get<K extends keyof Prefs>(k: K): Prefs[K]; set<K extends keyof Prefs>(k: K, v: Prefs[K]): void }
  text(ref: { id: Id; field: 'body' | 'front' | 'back' }): Y.Text
  batch<T>(fn: () => T): T
  subscribe(scope: Scope, fn: () => void): () => void
}
