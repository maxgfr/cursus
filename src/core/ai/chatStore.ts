/**
 * The tutor chat's conversations, kept on this device only (`kv`, one key per course and one for the whole
 * library), never synced: they touch neither the workspace nor the sync format. Newest first, at most
 * `MAX_CONVERSATIONS` per course; the oldest go first.
 */
import type { LocalStore } from '../contracts/ports'
import type { ChatMessage } from './features/tutorChat'

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

const isMessage = (m: unknown): m is ChatMessage =>
  typeof m === 'object' &&
  m !== null &&
  ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
  typeof (m as ChatMessage).text === 'string'

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
