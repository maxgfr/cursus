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
export interface SourceInput {
  courseId: Id
  kind: 'note' | 'pdf' | 'image'
  title: string
  blobId?: string
}
export interface Source extends EntityMeta, SourceInput {}
export interface FicheInput {
  courseId: Id
  title: string
  sourceIds?: Id[]
}
export interface Fiche extends EntityMeta, FicheInput {}
export interface CardInput {
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
export type Scope = 'courses' | 'sources' | 'fiches' | 'cards' | 'reviews' | 'prefs' | { id: Id }

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
  reviews: { record(r: NewReview): Id; void(id: Id): void; forCard(id: Id): readonly Review[] }
  prefs: { get<K extends keyof Prefs>(k: K): Prefs[K]; set<K extends keyof Prefs>(k: K, v: Prefs[K]): void }
  text(ref: { id: Id; field: 'body' | 'front' | 'back' }): Y.Text
  batch<T>(fn: () => T): T
  subscribe(scope: Scope, fn: () => void): () => void
}
