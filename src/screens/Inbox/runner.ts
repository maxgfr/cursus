import type { Runtime } from '../../app/workspaceContext.tsx'
import { noteUnits, type SourceContent } from '../../core/ai/autoQuestions'
import { createModel } from '../../core/ai/client'
import { routeStatus } from '../../core/ai/deviceCheck'
import { supportsImages } from '../../core/ai/features/readDeck'
import { type AiJobs, createJobs, type JobModel } from '../../core/ai/jobs'
import { LOCAL_PROVIDER } from '../../core/ai/local'
import type { SourceRecord } from '../../core/model/schema'
import { secretsVault } from '../../core/storage/secrets'
import { loadDeck } from '../DeckImport/deckSource.ts'
import { runInputs } from '../Generate/deckInputs.ts'
import { CUSTOM_PROVIDER, loadAiSettings, recordUsage, resolveRoute } from '../Understand/shared/aiConfig.ts'
import { PHOTO_UNIT, photoGenerator } from './photoGenerator.ts'

/**
 * The device's background queue of the cards the student asks for, wired to this app: the model of the AI
 * settings (an on-device one needs no connection) and each source's content read from this device (a note split
 * by heading, a deck or PDF from its stored file, a photo for a vision model). Loaded on demand only (it brings
 * the AI code).
 */
export function createRunner(rt: Runtime): AiJobs {
  const vault = secretsVault(rt.store)
  let last: JobModel | null = null

  const model = async (): Promise<JobModel | null> => {
    const s = await loadAiSettings(vault)
    last = null
    const local = s.local
    const route = resolveRoute(s.config, s.catalog, CUSTOM_PROVIDER, (id) =>
      local?.info.id === id ? local.info : undefined,
    )
    if (!route) return null
    const onDevice = route.provider.id === LOCAL_PROVIDER
    // Same rules as the screens (`useAiModel`): downloaded here, a route not moved, a key unless a local server.
    if (onDevice && local?.downloaded !== true) return null
    if (!onDevice) {
      if (routeStatus(route.provider, s.checks, rt.clock.now()).kind === 'moved') return null
      if (s.apiKey === '' && route.provider.id !== CUSTOM_PROVIDER) return null
    }
    last = {
      info: route.info,
      local: onDevice,
      context: async (signal, language) => ({
        model: await createModel({ provider: route.provider, modelId: route.info.id, apiKey: s.apiKey }),
        info: route.info,
        language,
        signal,
        onUsage: (e) => recordUsage(rt.ws, e),
      }),
    }
    return last
  }

  // A deck read for the estimate is read again for the run: the last ones stay (pages rendered included).
  const decks = new Map<string, Promise<SourceContent>>()
  const readDeck = (source: SourceRecord, vision: boolean, signal: AbortSignal): Promise<SourceContent> => {
    const key = `${source.id}:${source.blobId ?? ''}:${vision ? 'images' : 'text'}`
    const hit = decks.get(key)
    if (hit) return hit
    const read = (async () => {
      const loaded = await loadDeck(rt, source)
      const indexes = loaded.deck.units.filter((u) => u.hidden !== true).map((u) => u.index)
      const { units } = await runInputs(loaded, indexes, vision, signal)
      return { title: loaded.deck.title.trim() || source.title, units }
    })()
    decks.set(key, read)
    while (decks.size > 2) {
      const oldest = decks.keys().next().value
      if (oldest === undefined) break
      decks.delete(oldest)
    }
    // A failed or interrupted read is not kept: the next attempt reads again.
    read.catch(() => decks.delete(key))
    return read
  }

  const content = async (source: SourceRecord, signal: AbortSignal): Promise<SourceContent | null> => {
    if (source.kind === 'image') {
      const text = source.caption?.trim() ?? ''
      return {
        title: source.title,
        units: [{ index: PHOTO_UNIT, kind: 'page', label: '1', title: source.title, text }],
      }
    }
    if (source.kind === 'pdf' || source.support !== undefined) {
      return readDeck(source, last !== null && supportsImages(last.info), signal)
    }
    const body = rt.ws.text({ id: source.id, field: 'body' }).toString()
    return { title: source.title, units: noteUnits(source.title, body) }
  }

  return createJobs({
    ws: rt.ws,
    store: rt.store,
    locks: rt.locks,
    clock: rt.clock,
    rng: rt.rng,
    network: {
      online: () => navigator.onLine,
      subscribe: (fn) => {
        window.addEventListener('online', fn)
        window.addEventListener('offline', fn)
        return () => {
          window.removeEventListener('online', fn)
          window.removeEventListener('offline', fn)
        }
      },
    },
    model,
    content,
    generators: { image: photoGenerator(rt) },
  })
}
