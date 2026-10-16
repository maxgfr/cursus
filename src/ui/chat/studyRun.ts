/**
 * What the study screens run: the passages of the sources chosen (a photo's reading included), a quiz, a photo read
 * by a vision model, a student's explanation checked. Nothing here writes to the workspace but a photo's reading,
 * kept on this device.
 */
import type { Runtime } from '../../app/workspaceContext.tsx'
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
import { quiz } from '../../core/ai/features/quiz'
import type { RichResult, StudyOptions } from '../../core/ai/features/tutorChat'
import type { Chunk } from '../../core/ai/retrieval'
import type { ExplainBackReview, QuizQuestion } from '../../core/ai/schemas'
import { blobStore } from '../../core/log/blobs'
import { getPhoto } from '../../core/model/photos'
import { weakCards } from '../../core/model/quizPlan'
import type { ModelWorkspace } from '../../core/model/workspace'
import type { useT } from '../../i18n/react.tsx'
import { type AiModelState, courseText, passagesText } from '../../screens/Understand/shared/aiConfig.ts'
import { chunksFor, deckReader } from '../../screens/Understand/shared/sources.ts'

export type ReadyModel = Extract<AiModelState, { status: 'ready' }>
type T = ReturnType<typeof useT>

/** The name of a course or section, as the thread says where something is saved or read from. */
export function placeName(ws: ModelWorkspace, place: { courseId: string; sectionId?: string }): string {
  const section = place.sectionId ? ws.sections.get(place.sectionId) : undefined
  return section?.name ?? ws.courses.get(place.courseId)?.title ?? ''
}

/**
 * Reads the passages of the chosen sources, cached by choice, and what a model read on the chosen photos, read
 * again each time: a photo read since (here or on its own screen) counts at once, never an earlier « nothing read ».
 */
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
      loading = chunksFor(ws, blobs, o.sourceIds, o.pasted, readDeck)
      cache.set(key, loading)
      loading.catch(() => cache.delete(key))
    }
    const photos = o.sourceIds.filter((id) => ws.sources.get(id)?.kind === 'image')
    return Promise.all([loading, readingChunks(rt.store, photos)]).then(([chunks, read]) => [...chunks, ...read])
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

/** A quiz from the options' sources, streamed through `run.onPartial`; nothing to read, no question. */
export async function runQuiz(d: StudyDeps, options: StudyOptions, run: Run): Promise<QuizQuestion[]> {
  const { ws, ai, t } = d
  const chunks = await d.load(options)
  // Nothing to read (no source chosen, sources still empty): nothing is asked.
  if (chunks.length === 0) return []
  const course = ws.courses.get(options.courseId)
  const ctx = { ...(await ai.context(run.signal, course?.language, passagesText(chunks))), onPartial: run.onPartial }
  const place = options.sectionId
    ? { courseId: options.courseId, sectionId: options.sectionId }
    : { courseId: options.courseId }
  // The weak points of the place, read from its cards' reviews when asked for.
  const focus =
    options.focusWeak === true && options.courseId !== '' ? weakCards(ws, place, Date.now()).map((w) => w.front) : []
  return quiz(ctx, {
    topic: topicOf(t, options),
    chunks,
    count: options.count,
    ...(options.difficulty ? { difficulty: options.difficulty } : {}),
    ...(focus.length > 0 ? { focus } : {}),
  })
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
