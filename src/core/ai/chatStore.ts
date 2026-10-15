/**
 * The tutor chat's conversations, kept on this device only (`kv`, one key per course and one for the whole
 * library), never synced: they touch neither the workspace nor the sync format. Newest first, at most
 * `MAX_CONVERSATIONS` per course; the oldest go first.
 */
import { z } from 'zod'
import type { LocalStore } from '../contracts/ports'
import type { ChatMessage } from './features/tutorChat'
import {
  cardDraftSchema,
  explainBackSchema,
  improveCardSchema,
  photoDescriptionSchema,
  quizQuestionSchema,
  understandSchema,
} from './schemas'

export const MAX_CONVERSATIONS = 20
const TITLE_CHARS = 60

export interface Conversation {
  id: string
  /** The first question, shortened. */
  title: string
  messages: ChatMessage[]
  updatedAt: number
}

interface Stored {
  v: 1
  chats: Conversation[]
}

/** The kv key of a course's conversations; without a course, the library's. */
export function chatKey(courseId?: string): string {
  return `ai:chat:${courseId ?? '-'}`
}

export function titleOf(messages: readonly ChatMessage[]): string {
  const first =
    messages
      .find((m) => m.role === 'user')
      ?.text.replace(/\s+/g, ' ')
      .trim() ?? ''
  return first.length > TITLE_CHARS ? `${first.slice(0, TITLE_CHARS - 1).trimEnd()}…` : first
}

const ref = z.object({ sourceId: z.string(), page: z.number().optional() })
const guarded = z.object({ text: z.string(), leaked: z.boolean(), original: z.string().optional() })
const faces = z.object({ front: z.string(), back: z.string() })
const common = { card: faces, cost: z.number().optional() }

const options = z.object({
  courseId: z.string(),
  sectionId: z.string().optional(),
  sourceIds: z.array(z.string()),
  pasted: z.string(),
  topic: z.string(),
  count: z.union([z.number(), z.literal('all')]),
  detail: z.enum(['short', 'standard', 'deep']),
})

const draft = cardDraftSchema.extend({
  duplicate: z.boolean(),
  savedId: z.string().optional(),
  removed: z.boolean().optional(),
})

/**
 * A structured answer as stored: « Explain the question », « Why? », generated cards, a quiz, a study sheet, a
 * graded answer, a photo read, a card rewritten, or cards proposed on a source.
 */
const richSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cards'),
    options,
    drafts: z.array(draft),
    photoIds: z.array(z.string()).optional(),
    cost: z.number().optional(),
    empty: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('quiz'),
    options,
    questions: z.array(quizQuestionSchema),
    answers: z.array(z.number()),
    step: z.number(),
    cost: z.number().optional(),
    empty: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('sheet'),
    options,
    value: understandSchema,
    savedId: z.string().optional(),
    review: explainBackSchema.optional(),
    cost: z.number().optional(),
    empty: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('grade'),
    card: faces,
    answer: z.string(),
    rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    feedback: z.string(),
    rated: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  }),
  z.object({
    kind: z.literal('photo'),
    photoId: z.string(),
    courseId: z.string(),
    description: photoDescriptionSchema,
    cost: z.number().optional(),
  }),
  z.object({
    kind: z.literal('improve'),
    cardId: z.string(),
    card: faces,
    value: improveCardSchema,
    applied: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('job'), sourceId: z.string() }),
  z.object({
    kind: z.literal('explainQuestion'),
    value: z.object({
      restatement: guarded,
      terms: z.array(z.object({ term: guarded, definition: guarded, sourceRef: ref.optional() })),
      context: guarded,
      citations: z.array(ref),
      leaked: z.boolean(),
    }),
    ...common,
  }),
  z.object({
    kind: z.literal('explainCard'),
    value: z.object({
      explanation: z.string(),
      example: z.string().optional(),
      mnemonic: z.string().optional(),
      sourceRef: ref.optional(),
      citations: z.array(ref),
    }),
    ...common,
  }),
])

const isMessage = (m: unknown): m is ChatMessage =>
  typeof m === 'object' &&
  m !== null &&
  ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
  typeof (m as ChatMessage).text === 'string' &&
  ['id', 'photoId'].every((k) => {
    const v = (m as Record<string, unknown>)[k]
    return v === undefined || typeof v === 'string'
  }) &&
  ((m as ChatMessage).rich === undefined || richSchema.safeParse((m as ChatMessage).rich).success)

const isConversation = (c: unknown): c is Conversation =>
  typeof c === 'object' &&
  c !== null &&
  typeof (c as Conversation).id === 'string' &&
  typeof (c as Conversation).title === 'string' &&
  typeof (c as Conversation).updatedAt === 'number' &&
  Array.isArray((c as Conversation).messages) &&
  (c as Conversation).messages.every(isMessage)

/** Stored conversations, newest first; anything unreadable is left out. */
export async function listConversations(store: LocalStore, courseId?: string): Promise<Conversation[]> {
  const raw = await store.read(['kv'], (tx) => tx.get<unknown>('kv', chatKey(courseId)))
  const chats = (raw as Stored | undefined)?.chats
  if (!Array.isArray(chats)) return []
  return chats.filter(isConversation).sort((a, b) => b.updatedAt - a.updatedAt)
}

async function write(store: LocalStore, courseId: string | undefined, chats: Conversation[]): Promise<Conversation[]> {
  const kept = [...chats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS)
  if (kept.length === 0) await store.commit([{ delete: 'kv', key: chatKey(courseId) }])
  else await store.commit([{ put: 'kv', key: chatKey(courseId), value: { v: 1, chats: kept } satisfies Stored }])
  return kept
}

/** Adds or replaces a conversation (titled after its first question); returns the list as stored. */
export async function saveConversation(
  store: LocalStore,
  courseId: string | undefined,
  chat: Omit<Conversation, 'title'>,
): Promise<Conversation[]> {
  const others = (await listConversations(store, courseId)).filter((c) => c.id !== chat.id)
  return write(store, courseId, [{ ...chat, title: titleOf(chat.messages) }, ...others])
}

export async function deleteConversation(
  store: LocalStore,
  courseId: string | undefined,
  id: string,
): Promise<Conversation[]> {
  return write(
    store,
    courseId,
    (await listConversations(store, courseId)).filter((c) => c.id !== id),
  )
}

export async function clearConversations(store: LocalStore, courseId: string | undefined): Promise<void> {
  await write(store, courseId, [])
}
