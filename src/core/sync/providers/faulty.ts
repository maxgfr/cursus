import { RemoteError } from '../../contracts/errors'
import type { Rng } from '../../contracts/ports'
import type { Entry, Key, RemoteStore } from '../../contracts/remote'

/**
 * Faults a real provider shows sooner or later:
 * - put-before: fails before storing; put-after: stores, then fails; put-lost: says OK, stores nothing;
 * - put-corrupt: stores damaged bytes; get-corrupt: returns damaged bytes once; get-fail: network error;
 * - list-fail: a page fails; list-omit: a page silently missing; list-dup: a page served twice;
 * - rate-limit: 429 with Retry-After; auth: expired credentials; quota: storage full.
 */
export type Fault =
  | 'put-before'
  | 'put-after'
  | 'put-lost'
  | 'put-corrupt'
  | 'get-corrupt'
  | 'get-fail'
  | 'list-fail'
  | 'list-omit'
  | 'list-dup'
  | 'rate-limit'
  | 'auth'
  | 'quota'

type Op = 'put' | 'get' | 'page'

const APPLIES: Record<Op, readonly Fault[]> = {
  put: ['auth', 'rate-limit', 'quota', 'put-before', 'put-after', 'put-lost', 'put-corrupt'],
  get: ['auth', 'rate-limit', 'get-fail', 'get-corrupt'],
  page: ['auth', 'rate-limit', 'list-fail', 'list-omit', 'list-dup'],
}

export interface FaultyRemote extends RemoteStore {
  readonly inner: RemoteStore
  /** The next `times` operations this fault applies to get it. */
  inject(f: Fault, times?: number): void
  /** Each applicable operation gets fault f with probability p[f], drawn from rng (deterministic). */
  randomly(rng: Rng, p: Partial<Record<Fault, number>>): void
  /** Sticky conditions: no network, credentials expired (until reauth), storage full. */
  offline: boolean
  authExpired: boolean
  quotaFull: boolean
  reauth(): void
  /** Lifts every fault: sticky, queued and random. */
  heal(): void
  /** Faults that actually fired, in order. */
  readonly fired: Fault[]
}

function damage(bytes: Uint8Array): Uint8Array {
  const out = bytes.length === 0 ? new Uint8Array(1) : bytes.slice()
  out[out.length - 1] = (out[out.length - 1] ?? 0) ^ 0x5a
  return out
}

export function faultyRemote(inner: RemoteStore, o: { retryAfterMs?: number; pageSize?: number } = {}): FaultyRemote {
  const queued = new Map<Fault, number>()
  let random: { rng: Rng; p: Partial<Record<Fault, number>> } | null = null
  const fired: Fault[] = []
  const retryAfterMs = o.retryAfterMs ?? 2000

  const pick = (op: Op): Fault | null => {
    for (const f of APPLIES[op]) {
      const n = queued.get(f) ?? 0
      if (n > 0) {
        if (n === 1) queued.delete(f)
        else queued.set(f, n - 1)
        fired.push(f)
        return f
      }
    }
    if (random) {
      for (const f of APPLIES[op]) {
        const p = random.p[f] ?? 0
        if (p > 0 && random.rng.u32() / 2 ** 32 < p) {
          fired.push(f)
          return f
        }
      }
    }
    return null
  }

  const sticky = (op: Op): void => {
    if (self.offline) throw new RemoteError('network', 'offline')
    if (self.authExpired) throw new RemoteError('auth', 'credentials expired')
    if (op === 'put' && self.quotaFull) throw new RemoteError('quota', 'storage full')
  }

  /** Faults common to every operation; returns the fault left for the operation itself. */
  const common = (op: Op): Fault | null => {
    sticky(op)
    const f = pick(op)
    if (f === 'auth') throw new RemoteError('auth', 'credentials expired')
    if (f === 'rate-limit') throw new RemoteError('rate-limited', '429 Too Many Requests', retryAfterMs)
    if (f === 'quota') throw new RemoteError('quota', 'storage full')
    if (f === 'get-fail' || f === 'list-fail' || f === 'put-before') throw new RemoteError('network', `${f} injected`)
    return f
  }

  const self: FaultyRemote = {
    inner,
    ...(inner.incremental ? { incremental: inner.incremental } : {}),
    get id() {
      return inner.id
    },
    offline: false,
    authExpired: false,
    quotaFull: false,
    fired,
    inject(f, times = 1) {
      queued.set(f, (queued.get(f) ?? 0) + times)
    },
    randomly(rng, p) {
      random = { rng, p }
    },
    reauth() {
      self.authExpired = false
    },
    heal() {
      queued.clear()
      random = null
      self.offline = false
      self.authExpired = false
      self.quotaFull = false
    },
    list(prefix, lo) {
      const pageSize = Math.max(1, lo?.pageSize ?? o.pageSize ?? 1000)
      return {
        async *[Symbol.asyncIterator]() {
          let page: Entry[] = []
          const flush = function* (): Generator<Entry> {
            const f = common('page')
            if (f !== 'list-omit') yield* page
            if (f === 'list-dup') yield* page
            page = []
          }
          sticky('page')
          for await (const e of inner.list(prefix, lo)) {
            page.push(e)
            if (page.length >= pageSize) yield* flush()
          }
          if (page.length > 0) yield* flush()
        },
      }
    },
    async get(e) {
      const f = common('get')
      const bytes = await inner.get(e)
      if (bytes && f === 'get-corrupt') return damage(bytes)
      return bytes
    },
    async put(key: Key, body: Uint8Array) {
      const f = common('put')
      if (f === 'put-lost') return
      if (f === 'put-corrupt') return inner.put(key, damage(body))
      await inner.put(key, body)
      if (f === 'put-after') throw new RemoteError('network', 'connection reset after upload')
    },
  }
  return self
}
