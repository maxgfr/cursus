import { type Entry, type Key, RemoteError, type RemoteStore } from '../../contracts/remote'

/**
 * A RemoteStore served by a nearby device over a (DTLS-encrypted) WebRTC data channel. Each side
 * may serve its own store and query the other's over the same channel. Messages are split into
 * frames of at most 64 KB; senders wait for `bufferedamountlow` when the channel's buffer fills.
 *
 * Frame: kind (1 byte: request, response, error) | id (u32) | last (1 byte) | chunk.
 * A message, once reassembled: header length (u32) | JSON header | body.
 */

/** The subset of a binary data channel the store needs; `dataChannelFrames` adapts RTCDataChannel. */
export interface FrameChannel {
  readonly bufferedAmount: number
  bufferedAmountLowThreshold: number
  send(frame: Uint8Array): void
  onFrame(cb: (frame: Uint8Array) => void): void
  onBufferedLow(cb: () => void): void
  onClose(cb: () => void): void
  close(): void
}

export const MAX_FRAME = 64 * 1024
const FRAME_HEAD = 6
/** Pause sending above this many buffered bytes; resume when the channel reports low water. */
const HIGH_WATER = 1024 * 1024
const LOW_WATER = 256 * 1024

const REQ = 1
const RES = 2
const ERR = 3

type Request =
  | { op: 'get'; key: Key; handle?: string }
  | { op: 'put'; key: Key }
  | { op: 'list'; prefix: string; startAfter?: Key; createdAfter?: number }

interface Message {
  header: unknown
  body: Uint8Array
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function packMessage(header: unknown, body: Uint8Array = new Uint8Array()): Uint8Array {
  const h = enc.encode(JSON.stringify(header))
  const out = new Uint8Array(4 + h.length + body.length)
  new DataView(out.buffer).setUint32(0, h.length)
  out.set(h, 4)
  out.set(body, 4 + h.length)
  return out
}

function unpackMessage(bytes: Uint8Array): Message {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  return { header: JSON.parse(dec.decode(bytes.subarray(4, 4 + len))), body: bytes.slice(4 + len) }
}

/** Adapts a browser RTCDataChannel (binary, ordered) to a FrameChannel. */
export function dataChannelFrames(dc: RTCDataChannel): FrameChannel {
  dc.binaryType = 'arraybuffer'
  return {
    get bufferedAmount() {
      return dc.bufferedAmount
    },
    get bufferedAmountLowThreshold() {
      return dc.bufferedAmountLowThreshold
    },
    set bufferedAmountLowThreshold(v: number) {
      dc.bufferedAmountLowThreshold = v
    },
    send: (frame) => dc.send(frame as Uint8Array<ArrayBuffer>),
    onFrame: (cb) =>
      dc.addEventListener('message', (e) => {
        if (e.data instanceof ArrayBuffer) cb(new Uint8Array(e.data))
      }),
    onBufferedLow: (cb) => dc.addEventListener('bufferedamountlow', cb),
    onClose: (cb) => dc.addEventListener('close', cb),
    close: () => dc.close(),
  }
}

export interface PeerStore extends RemoteStore {
  close(): void
}

/**
 * Opens the peer protocol on `channel`: returns a RemoteStore reading the other device's store,
 * and answers the other device's requests from `serve` when given.
 */
export function peerStore(channel: FrameChannel, o: { id: string; serve?: RemoteStore }): PeerStore {
  let closed = false
  let nextId = 1
  const pending = new Map<number, { resolve: (m: Message) => void; reject: (e: Error) => void }>()
  const partial = new Map<string, Uint8Array[]>()
  let lowWaiters: (() => void)[] = []

  channel.bufferedAmountLowThreshold = LOW_WATER
  channel.onBufferedLow(() => {
    const w = lowWaiters
    lowWaiters = []
    for (const r of w) r()
  })

  const offline = () => new RemoteError('network', 'Nearby device disconnected')

  channel.onClose(() => {
    if (closed) return
    closed = true
    for (const p of pending.values()) p.reject(offline())
    pending.clear()
    const w = lowWaiters
    lowWaiters = []
    for (const r of w) r()
  })

  async function sendMessage(kind: number, id: number, bytes: Uint8Array): Promise<void> {
    const step = MAX_FRAME - FRAME_HEAD
    let at = 0
    do {
      while (!closed && channel.bufferedAmount > HIGH_WATER) await new Promise<void>((r) => lowWaiters.push(r))
      if (closed) throw offline()
      const chunk = bytes.subarray(at, at + step)
      at += chunk.length
      const frame = new Uint8Array(FRAME_HEAD + chunk.length)
      frame[0] = kind
      new DataView(frame.buffer).setUint32(1, id)
      frame[5] = at >= bytes.length ? 1 : 0
      frame.set(chunk, FRAME_HEAD)
      channel.send(frame)
    } while (at < bytes.length)
  }

  async function serveRequest(id: number, m: Message): Promise<void> {
    let reply: Uint8Array
    let kind = RES
    try {
      if (!o.serve) throw new RemoteError('permission', 'This device does not share its store')
      const r = m.header as Request
      if (r.op === 'get') {
        const body = await o.serve.get(r.handle === undefined ? { key: r.key } : { key: r.key, handle: r.handle })
        reply = packMessage({ found: body !== null }, body ?? undefined)
      } else if (r.op === 'put') {
        await o.serve.put(r.key, m.body)
        reply = packMessage({})
      } else if (r.op === 'list') {
        const entries: Entry[] = []
        for await (const e of o.serve.list(r.prefix, { startAfter: r.startAfter, createdAfter: r.createdAfter }))
          entries.push(e)
        reply = packMessage({ entries })
      } else throw new RemoteError('permission', 'Unknown request')
    } catch (e) {
      kind = ERR
      const k = e instanceof RemoteError ? e.kind : 'network'
      reply = packMessage({ kind: k, message: e instanceof Error ? e.message : String(e) })
    }
    // A reply that cannot be sent because the peer left has nobody to report to.
    await sendMessage(kind, id, reply).catch((e: unknown) => {
      if (!(e instanceof RemoteError)) throw e
    })
  }

  channel.onFrame((frame) => {
    if (frame.length < FRAME_HEAD) return
    const kind = frame[0] ?? 0
    const id = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1)
    const slot = `${kind}:${id}`
    const parts = partial.get(slot) ?? []
    parts.push(frame.slice(FRAME_HEAD))
    if (frame[5] !== 1) {
      partial.set(slot, parts)
      return
    }
    partial.delete(slot)
    const size = parts.reduce((n, p) => n + p.length, 0)
    const whole = new Uint8Array(size)
    let at = 0
    for (const p of parts) {
      whole.set(p, at)
      at += p.length
    }
    const m = unpackMessage(whole)
    if (kind === REQ) {
      void serveRequest(id, m)
      return
    }
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (kind === ERR) {
      const h = m.header as { kind: RemoteError['kind']; message: string }
      p.reject(new RemoteError(h.kind, h.message))
    } else p.resolve(m)
  })

  async function call(req: Request, body?: Uint8Array): Promise<Message> {
    if (closed) throw offline()
    const id = nextId++
    const answer = new Promise<Message>((resolve, reject) => pending.set(id, { resolve, reject }))
    try {
      await sendMessage(REQ, id, packMessage(req, body))
    } catch (e) {
      pending.delete(id)
      throw e
    }
    return answer
  }

  return {
    id: o.id,
    async *list(prefix, opts) {
      const m = await call({ op: 'list', prefix, startAfter: opts?.startAfter, createdAfter: opts?.createdAfter })
      yield* (m.header as { entries: Entry[] }).entries
    },
    async get(e) {
      const m = await call(
        e.handle === undefined ? { op: 'get', key: e.key } : { op: 'get', key: e.key, handle: e.handle },
      )
      return (m.header as { found: boolean }).found ? m.body : null
    },
    async put(key, body) {
      await call({ op: 'put', key }, body)
    },
    close() {
      channel.close()
    },
  }
}
