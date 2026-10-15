import { describe, expect, test } from 'bun:test'
import { memoryStore } from '../storage/memoryStore'
import {
  chatKey,
  clearConversations,
  deleteConversation,
  listConversations,
  MAX_CONVERSATIONS,
  saveConversation,
  titleOf,
} from './chatStore'

const chat = (id: string, updatedAt: number, question = `question ${id}`) => ({
  id,
  updatedAt,
  messages: [
    { role: 'user' as const, text: question },
    { role: 'assistant' as const, text: 'answer' },
  ],
})

describe('chat store', () => {
  test('conversations are kept per course, newest first, titled by their first question', async () => {
    const store = memoryStore()
    await saveConversation(store, 'c1', chat('a', 1))
    await saveConversation(store, 'c1', chat('b', 3))
    await saveConversation(store, 'c2', chat('x', 2))
    await saveConversation(store, undefined, chat('lib', 2))
    expect((await listConversations(store, 'c1')).map((c) => [c.id, c.title])).toEqual([
      ['b', 'question b'],
      ['a', 'question a'],
    ])
    expect((await listConversations(store, 'c2')).map((c) => c.id)).toEqual(['x'])
    expect((await listConversations(store)).map((c) => c.id)).toEqual(['lib'])
    expect(chatKey()).not.toBe(chatKey('c1'))
  })

  test('saving again replaces the conversation and moves it first', async () => {
    const store = memoryStore()
    await saveConversation(store, 'c', chat('a', 1))
    await saveConversation(store, 'c', chat('b', 2))
    const list = await saveConversation(store, 'c', { ...chat('a', 5), messages: [...chat('a', 5).messages] })
    expect(list.map((c) => c.id)).toEqual(['a', 'b'])
  })

  test(`at most ${MAX_CONVERSATIONS} per course: the oldest go`, async () => {
    const store = memoryStore()
    for (let i = 0; i < MAX_CONVERSATIONS + 3; i++) await saveConversation(store, 'c', chat(`n${i}`, i))
    const list = await listConversations(store, 'c')
    expect(list).toHaveLength(MAX_CONVERSATIONS)
    expect(list.at(-1)?.id).toBe('n3')
  })

  test('one or all can be deleted', async () => {
    const store = memoryStore()
    await saveConversation(store, 'c', chat('a', 1))
    await saveConversation(store, 'c', chat('b', 2))
    expect((await deleteConversation(store, 'c', 'a')).map((c) => c.id)).toEqual(['b'])
    await clearConversations(store, 'c')
    expect(await listConversations(store, 'c')).toEqual([])
    expect(store.size('kv')).toBe(0)
  })

  test('unreadable stored data is ignored', async () => {
    const store = memoryStore()
    await store.commit([
      { put: 'kv', key: chatKey('c'), value: { v: 1, chats: [{ id: 1 }, { ...chat('ok', 1), title: 'ok' }] } },
    ])
    expect((await listConversations(store, 'c')).map((c) => c.id)).toEqual(['ok'])
    await store.commit([{ put: 'kv', key: chatKey('c'), value: 'junk' }])
    expect(await listConversations(store, 'c')).toEqual([])
  })

  test('long first questions are shortened for the title', () => {
    const title = titleOf([{ role: 'user', text: `  ${'a'.repeat(100)}  ` }])
    expect(title.length).toBe(60)
    expect(title.endsWith('…')).toBe(true)
    expect(titleOf([{ role: 'assistant', text: 'seed' }])).toBe('')
  })
})
