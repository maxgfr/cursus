import { expect, test } from 'bun:test'
import type { CacheLike, CachesLike } from './local'

/** An in-memory Cache Storage. */
export function memoryCaches(): CachesLike & { names(): string[] } {
  const store = new Map<string, Map<string, Response>>()
  const cacheOf = (entries: Map<string, Response>): CacheLike => ({
    match: async (url) => entries.get(url)?.clone(),
    keys: async () => [...entries.keys()].map((url) => ({ url })),
    put: async (url, response) => {
      entries.set(url, response)
    },
    delete: async (url) => entries.delete(url),
  })
  return {
    open: async (name) => {
      const entries = store.get(name) ?? new Map<string, Response>()
      store.set(name, entries)
      return cacheOf(entries)
    },
    has: async (name) => store.has(name),
    names: () => [...store.keys()],
  }
}

test('memory caches keep entries per name', async () => {
  const caches = memoryCaches()
  expect(await caches.has('a')).toBe(false)
  await (await caches.open('a')).put('u', new Response('{"x":1}'))
  expect(await (await (await caches.open('a')).match('u'))?.json()).toEqual({ x: 1 })
  expect(caches.names()).toEqual(['a'])
})
