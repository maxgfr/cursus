/**
 * The study actions of the chat, as the thread runs them: each one reads what it is grounded in, calls the core
 * feature (cards, quiz, study sheet, a graded answer, a rewrite, a photo) and returns the structured answer the
 * thread keeps. Nothing here writes to the workspace: saving stays a button the student presses.
 */
import type { Runtime } from '../../app/workspaceContext.tsx'
import { flagDuplicates } from '../../core/ai/dedupe'
import {
  canSeeImages,
  DESCRIBE_OUTPUT_TOKENS,
  describePhoto,
  estimatePhotoCost,
  loadReadings,
  type PhotoImage,
  readingChunks,
  saveReading,
  VisionRequiredError,
} from '../../core/ai/features/describePhoto'
import { explainBack } from '../../core/ai/features/explainBack'
import { generateCards } from '../../core/ai/features/generateCards'
import { gradeAnswer } from '../../core/ai/features/gradeAnswer'
import { improveCard } from '../../core/ai/features/improveCard'
import { estimatePhotoCardsCost, photoToCards } from '../../core/ai/features/photoToCards'
import { quiz } from '../../core/ai/features/quiz'
import type { RichResult, StudyOptions } from '../../core/ai/features/tutorChat'
import { streamUnderstanding } from '../../core/ai/features/understand'
import type { Chunk } from '../../core/ai/retrieval'
import type { ExplainBackReview } from '../../core/ai/schemas'
import { blobStore } from '../../core/log/blobs'
import { getPhoto } from '../../core/model/photos'
import { weakCards } from '../../core/model/quizPlan'
import type { ModelWorkspace } from '../../core/model/workspace'
import type { useT } from '../../i18n/react.tsx'
import { type AiModelState, cardText, courseText, passagesText } from '../../screens/Understand/shared/aiConfig.ts'
import { chunksFor, deckReader, estimateCost } from '../../screens/Understand/shared/sources.ts'
import type { StudyKind } from './actions.ts'

export type ReadyModel = Extract<AiModelState, { status: 'ready' }>
type T = ReturnType<typeof useT>

/** Answer tokens one generated card takes, for the estimate. */
const TOKENS_PER_CARD = 150
const COUNTS: Record<StudyKind, StudyOptions['count']> = { generate: 10, quiz: 5, understand: 10 }

/** The name of a course or section, as the thread says where something is saved or read from. */
export function placeName(ws: ModelWorkspace, place: { courseId: string; sectionId?: string }): string {
  const section = place.sectionId ? ws.sections.get(place.sectionId) : undefined
  return section?.name ?? ws.courses.get(place.courseId)?.title ?? ''
}

/**
 * What a study action starts from: the course or section on screen (else the first course), all of its sources,
 * the usual number of items; a study sheet is about the place itself until the student names a topic. Cards and
 * study sheets need a course to be saved in; a quiz, saved nowhere, can work from pasted text alone.
 */
export function startOptions(
  ws: ModelWorkspace,
  kind: StudyKind,
  on: { courseId?: string; sectionId?: string },
): StudyOptions | null {
  const courseId = on.courseId ?? ws.courses.list()[0]?.id
  if (!courseId || !ws.courses.get(courseId)) {
    if (kind !== 'quiz') return null
    return { courseId: '', sourceIds: [], pasted: '', topic: '', count: COUNTS.quiz, detail: 'standard' }
  }
  const place = on.sectionId && on.courseId === courseId ? { courseId, sectionId: on.sectionId } : { courseId }
  return {
    ...place,
    sourceIds: ws.scoped('sources', place).map((s) => s.id),
    pasted: '',
    topic: kind === 'understand' ? placeName(ws, place) : '',
    count: COUNTS[kind],
    detail: 'standard',
  }
}

/** Reads the passages of the chosen sources (and of what a model read on chosen photos), cached by choice. */
export function chunkLoader(ws: ModelWorkspace, rt: Runtime) {
  const cache = new Map<string, Promise<Chunk[]>>()
  const blobs = blobStore(rt.store)
  const readDeck = deckReader(rt)
  const written = (id: string): string => {
    const s = ws.sources.get(id)
    if (s?.kind === 'note') return String(ws.text({ id, field: 'body' }).length)
    if (s?.kind === 'image') return `${ws.text({ id, field: 'body' }).length}:${s.caption ?? ''}`
    return ''
  }
  return (o: Pick<StudyOptions, 'sourceIds' | 'pasted'>): Promise<Chunk[]> => {
    // A note (or a photo's notes or caption) written in since is read again: its length is part of the key.
    const key = `${o.sourceIds.map((id) => `${id}:${written(id)}`).join(',')}\u0000${o.pasted}`
    let loading = cache.get(key)
    if (!loading) {
      const photos = o.sourceIds.filter((id) => ws.sources.get(id)?.kind === 'image')
      loading = Promise.all([
        chunksFor(ws, blobs, o.sourceIds, o.pasted, readDeck),
        readingChunks(rt.store, photos),
      ]).then(([chunks, read]) => [...chunks, ...read])
      cache.set(key, loading)
      loading.catch(() => cache.delete(key))
    }
    return loading
  }
}

export interface StudyDeps {
  ws: ModelWorkspace
  rt: Runtime
  ai: ReadyModel
  t: T
  load: (o: Pick<StudyOptions, 'sourceIds' | 'pasted'>) => Promise<Chunk[]>
}

export interface Run {
  signal: AbortSignal
  onPartial: (partial: unknown) => void
}

const topicOf = (t: T, o: StudyOptions) => o.topic.trim() || t('ai.wholeSelection')

/** Cards, a quiz or a study sheet from the options' sources, streamed through `run.onPartial`. */
export async function runStudy(d: StudyDeps, kind: StudyKind, options: StudyOptions, run: Run): Promise<RichResult> {
  const { ws, ai, t } = d
  const chunks = await d.load(options)
  // Nothing to read (no source chosen, nothing pasted, sources still empty): nothing is asked, the options wait.
  if (chunks.length === 0) {
    if (kind === 'generate') return { kind: 'cards', options, drafts: [], empty: true }
    if (kind === 'quiz') return { kind: 'quiz', options, questions: [], answers: [], step: 0, empty: true }
    return { kind: 'sheet', options, value: { title: '', summary: '', points: [] }, empty: true }
  }
  const course = ws.courses.get(options.courseId)
  const ctx = { ...(await ai.context(run.signal, course?.language, passagesText(chunks))), onPartial: run.onPartial }
  if (kind === 'generate') {
    const count = options.count === 'all' ? COUNTS.generate : options.count
    const cost = estimateCost(ai.info, chunks, TOKENS_PER_CARD * Number(count))
    const out = await generateCards(ctx, { topic: topicOf(t, options), chunks, count: Number(count) })
    const known = ws.cards
      .list({ courseId: options.courseId })
      .map((c) => ws.text({ id: c.id, field: 'front' }).toString())
    return { kind: 'cards', options, drafts: flagDuplicates(out, known), cost }
  }
  if (kind === 'quiz') {
    const cost = estimateCost(ai.info, chunks)
    const place = options.sectionId
      ? { courseId: options.courseId, sectionId: options.sectionId }
      : { courseId: options.courseId }
    // The weak points of the place, read from its cards' reviews when asked for.
    const focus =
      options.focusWeak === true && options.courseId !== '' ? weakCards(ws, place, Date.now()).map((w) => w.front) : []
    const questions = await quiz(ctx, {
      topic: topicOf(t, options),
      chunks,
      count: options.count,
      ...(options.difficulty ? { difficulty: options.difficulty } : {}),
      ...(focus.length > 0 ? { focus } : {}),
    })
    return { kind: 'quiz', options, questions, answers: [], step: 0, cost }
  }
  const cost = estimateCost(ai.info, chunks)
  const s = streamUnderstanding(ctx, { topic: topicOf(t, options), detail: options.detail, chunks })
  for await (const part of s.partial) run.onPartial(part)
  return { kind: 'sheet', options, value: await s.output, cost }
}

/** The student explains the sheet's topic back; checked against the same sources. */
export async function checkExplanation(
  d: StudyDeps,
  options: StudyOptions,
  explanation: string,
  run: Run,
): Promise<ExplainBackReview> {
  const chunks = await d.load(options)
  const course = d.ws.courses.get(options.courseId)
  const ctx = await d.ai.context(run.signal, course?.language, passagesText(chunks))
  return explainBack({ ...ctx, onPartial: run.onPartial }, { topic: topicOf(d.t, options), explanation, chunks })
}

/** An answer typed in the student's own words, graded against the card (the student keeps the final say). */
export async function runGrade(
  d: StudyDeps,
  card: { front: string; back: string },
  answer: string,
  language: string | undefined,
  run: Run,
): Promise<RichResult> {
  const ctx = await d.ai.context(run.signal, language, cardText(card))
  const g = await gradeAnswer({ ...ctx, onPartial: run.onPartial }, { front: card.front, back: card.back, answer })
  return { kind: 'grade', card, answer, rating: g.suggestedRating, feedback: g.feedback }
}

/** A rewrite of a hard card, proposed with « Use this version ». */
export async function runImprove(d: StudyDeps, cardId: string, run: Run): Promise<RichResult | null> {
  const { ws } = d
  const record = ws.cards.get(cardId)
  if (!record) return null
  const front = ws.text({ id: cardId, field: 'front' }).toString()
  const back = ws.text({ id: cardId, field: 'back' }).toString()
  const course = ws.courses.get(record.courseId)
  const ctx = await d.ai.context(run.signal, course?.language, cardText({ front, back }))
  const value = await improveCard({ ...ctx, onPartial: run.onPartial }, { front, back, kind: record.kind })
  return { kind: 'improve', cardId, card: { front, back }, value }
}

/** The photo isn't on this device (on-demand mode, not downloaded yet). */
export class PhotoUnavailableError extends Error {
  constructor(id: string) {
    super(`photo ${id} is not on this device`)
    this.name = 'PhotoUnavailableError'
  }
}

export type PhotoImages = (photoId: string) => Promise<PhotoImage>

/** Estimated cost of reading one photo, before it is sent. */
export const photoCost = (ai: ReadyModel) => estimatePhotoCost(ai.info, 1, DESCRIBE_OUTPUT_TOKENS)

/**
 * What a vision model reads on a photo: what was read before on this device shows again without a request,
 * unless `again`. Kept on this device so study sheets can ground in it and cite the photo.
 */
export async function runPhoto(
  d: StudyDeps,
  photoId: string,
  image: PhotoImages,
  again: boolean,
  run: Run,
): Promise<RichResult | null> {
  const { ws, ai, rt } = d
  const photo = getPhoto(ws, photoId)
  if (!photo) return null
  if (!again) {
    const [kept] = await loadReadings(rt.store, [photoId])
    if (kept) return { kind: 'photo', photoId, courseId: photo.courseId, description: kept.description }
  }
  if (!canSeeImages(ai.info)) throw new VisionRequiredError(ai.info.name)
  const course = ws.courses.get(photo.courseId)
  const ctx = await ai.context(run.signal, course?.language, courseText(ws, photo.courseId))
  const description = await describePhoto(
    { ...ctx, onPartial: run.onPartial },
    { photoId, image: await image(photoId), caption: photo.caption, courseTitle: course?.title },
  )
  await saveReading(rt.store, { photoId, description, model: `${ai.provider.id}/${ai.info.id}`, at: Date.now() })
  return { kind: 'photo', photoId, courseId: photo.courseId, description, cost: photoCost(ai) }
}

/** Estimated cost of drafting `count` cards from `photos` photos. */
export const photoCardsCost = (ai: ReadyModel, photos: number, count: number) =>
  estimatePhotoCardsCost(ai.info, photos, count)

/** Cards drafted from one or several photos of a course, flagged when the course has them already. */
export async function runPhotoCards(
  d: StudyDeps,
  courseId: string,
  photoIds: readonly string[],
  count: number,
  image: PhotoImages,
  run: Run,
): Promise<RichResult> {
  const { ws, ai } = d
  if (!canSeeImages(ai.info)) throw new VisionRequiredError(ai.info.name)
  const course = ws.courses.get(courseId)
  const ctx = await ai.context(run.signal, course?.language, courseText(ws, courseId))
  const photos = []
  for (const id of photoIds) photos.push({ photoId: id, image: await image(id), caption: getPhoto(ws, id)?.caption })
  const out = await photoToCards({ ...ctx, onPartial: run.onPartial }, { photos, count, courseTitle: course?.title })
  const known = ws.cards.list({ courseId }).map((c) => ws.text({ id: c.id, field: 'front' }).toString())
  const first = getPhoto(ws, photoIds[0] ?? '')
  const options: StudyOptions = {
    courseId,
    ...(first?.sectionId ? { sectionId: first.sectionId } : {}),
    sourceIds: [...photoIds],
    pasted: '',
    topic: '',
    count,
    detail: 'standard',
  }
  return {
    kind: 'cards',
    options,
    drafts: flagDuplicates(out, known),
    photoIds: [...photoIds],
    cost: photoCardsCost(ai, photoIds.length, count),
  }
}
