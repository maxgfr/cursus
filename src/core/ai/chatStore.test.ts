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
import type { ChatMessage } from './features/tutorChat'

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

  test('a structured answer is kept with its text, and old messages without one stay readable', async () => {
    const store = memoryStore()
    const card = { front: 'Powerhouse of the cell?', back: 'The mitochondrion' }
    const why: ChatMessage = {
      role: 'assistant',
      text: 'Respiration runs there.',
      rich: {
        kind: 'explainCard',
        card,
        cost: 0.001,
        value: { explanation: 'Respiration runs there.', mnemonic: 'Mighty', citations: [{ sourceId: 's1', page: 2 }] },
      },
    }
    const question: ChatMessage = {
      role: 'assistant',
      text: 'It asks where energy is made.',
      rich: {
        kind: 'explainQuestion',
        card,
        value: {
          restatement: { text: 'It asks where energy is made.', leaked: false },
          terms: [
            {
              term: { text: 'Powerhouse', leaked: false },
              definition: { text: 'The […]', leaked: true, original: 'The mitochondrion' },
              sourceRef: { sourceId: 's1' },
            },
          ],
          context: { text: '', leaked: false },
          citations: [{ sourceId: 's1' }],
          leaked: true,
        },
      },
    }
    const messages: ChatMessage[] = [{ role: 'user', text: 'Why?' }, why, { role: 'user', text: 'Explain' }, question]
    await saveConversation(store, 'c', { id: 'r', updatedAt: 1, messages })
    await saveConversation(store, 'c', chat('old', 0))
    const list = await listConversations(store, 'c')
    expect(list.find((c) => c.id === 'r')?.messages).toEqual(messages)
    expect(list.find((c) => c.id === 'old')?.messages).toEqual(chat('old', 0).messages)
  })

  test('the study answers are kept with what their buttons need: drafts, quiz progress, a saved sheet', async () => {
    const store = memoryStore()
    const options = {
      courseId: 'c',
      sectionId: 's',
      sourceIds: ['n1'],
      pasted: '',
      topic: 'Cells',
      count: 'all' as const,
      detail: 'deep' as const,
    }
    const rich: ChatMessage['rich'][] = [
      {
        kind: 'cards',
        options: { ...options, count: 10 },
        drafts: [
          { kind: 'basic', front: 'Q?', back: 'A', duplicate: false, savedId: 'card1' },
          { kind: 'cloze', front: 'The {{c1::cell}}.', back: '', duplicate: true, sourceRef: { sourceId: 'n1' } },
        ],
        photoIds: ['p1'],
        cost: 0.01,
      },
      {
        kind: 'quiz',
        options,
        questions: [{ question: 'Q?', choices: ['a', 'b'], answerIndex: 1, explanation: 'b' }],
        answers: [0],
        step: 0,
      },
      {
        kind: 'sheet',
        options,
        value: { title: 'Cells', summary: 'Small.', points: [{ heading: 'Walls', explanation: 'Rigid.' }] },
        savedId: 'f1',
        review: { score: 70, strengths: ['ok'], gaps: [], misconceptions: [], feedback: 'Good.' },
      },
      { kind: 'grade', card: { front: 'Q?', back: 'A' }, answer: 'a', rating: 3, feedback: 'Right.' },
      {
        kind: 'photo',
        photoId: 'p1',
        courseId: 'c',
        description: { kind: 'table', title: 'T', transcription: '', explanation: 'E', keyPoints: ['k'] },
      },
      {
        kind: 'improve',
        cardId: 'card1',
        card: { front: 'Q?', back: 'A' },
        value: { front: 'Q2?', back: 'A2', rationale: 'Clearer.' },
        applied: true,
      },
      { kind: 'job', sourceId: 'n1' },
    ]
    const messages: ChatMessage[] = rich.map((r) => ({ role: 'assistant', text: 'x', ...(r ? { rich: r } : {}) }))
    await saveConversation(store, 'c', {
      id: 'study',
      updatedAt: 1,
      messages: [{ role: 'user', text: 'Go' }, ...messages],
    })
    const [kept] = await listConversations(store, 'c')
    expect(kept?.messages.slice(1)).toEqual(messages)
  })

  test('a grade given to the card from the chat is kept with its suggestion; an impossible one is refused', async () => {
    const store = memoryStore()
    const graded: ChatMessage = {
      role: 'assistant',
      text: 'x',
      rich: { kind: 'grade', card: { front: 'Q?', back: 'A' }, answer: 'a', rating: 3, feedback: 'Right.', rated: 4 },
    }
    await saveConversation(store, 'c', { id: 'g', updatedAt: 1, messages: [{ role: 'user', text: 'a' }, graded] })
    expect((await listConversations(store, 'c'))[0]?.messages[1]).toEqual(graded)

    await store.commit([
      {
        put: 'kv',
        key: chatKey('c'),
        value: {
          v: 1,
          chats: [{ id: 'g', title: 'a', updatedAt: 1, messages: [{ ...graded, rich: { ...graded.rich, rated: 7 } }] }],
        },
      },
    ])
    expect(await listConversations(store, 'c')).toEqual([])
  })

  test('a malformed structured answer makes its conversation unreadable', async () => {
    const store = memoryStore()
    const bad = { role: 'assistant', text: 'x', rich: { kind: 'explainCard', card: { front: 'q' }, value: {} } }
    await store.commit([
      {
        put: 'kv',
        key: chatKey('c'),
        value: {
          v: 1,
          chats: [
            { id: 'bad', title: 't', updatedAt: 1, messages: [bad] },
            { ...chat('ok', 1), title: 'ok' },
          ],
        },
      },
    ])
    expect((await listConversations(store, 'c')).map((c) => c.id)).toEqual(['ok'])
  })
})
