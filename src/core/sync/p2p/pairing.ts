import { dataChannelFrames, type FrameChannel } from './peerStore'
import { decodeSignal, encodeSignal, minimiseSdp, rebuildSdp } from './signal'

/**
 * Pairing a nearby device. The host shows a pairing code and an offer (QR or text); the guest
 * enters both and returns an answer. Once the DTLS channel is open, each side proves it knows the
 * code by an HMAC bound to both DTLS fingerprints, so a swapped offer or answer (a man in the
 * middle of the copy-paste) is refused. Only then do destinations and secrets cross the channel.
 *
 * LAN only: no STUN or TURN server is configured, so the devices must reach each other directly
 * (Wi-Fi client isolation blocks it; iOS asks for the "Local Network" permission).
 */

export class PairingError extends Error {}

/** Crockford base32: no I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 13 symbols of 5 bits = 65 bits, above the 60 bits a typed code needs. */
export const CODE_LENGTH = 13
export const CODE_BITS = CODE_LENGTH * 5
const GATHER_TIMEOUT_MS = 3000
const PROOF_TAG = 'cursus-pair/1'

export function newPairingCode(
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const bytes = random(CODE_LENGTH)
  let s = ''
  for (const b of bytes) s += ALPHABET[b & 31]
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`
}

/** Canonical form of a typed code: case, dashes, spaces and look-alike letters forgiven. */
export function normalisePairingCode(text: string): string {
  const s = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.length !== CODE_LENGTH || [...s].some((c) => !ALPHABET.includes(c)))
    throw new PairingError('Pairing code must be 13 letters or digits')
  return s
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** HMAC-SHA256(code, tag | role | offer fingerprint | answer fingerprint). */
export async function pairingProof(
  code: string,
  role: 'host' | 'guest',
  offerFingerprint: Uint8Array,
  answerFingerprint: Uint8Array,
): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(normalisePairingCode(code)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const msg = enc.encode(`${PROOF_TAG}|${role}|${hex(offerFingerprint)}|${hex(answerFingerprint)}`)
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)))
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

/** What the host hands over: sync destinations and the secrets they need (tokens, keys). */
export interface PairingBundle {
  destinations: unknown[]
  secrets: Record<string, unknown>
}

export interface PeerLink {
  /** Binary frames for `peerStore`. */
  frames: FrameChannel
  sendBundle(b: PairingBundle): void
  receiveBundle(): Promise<PairingBundle>
  close(): void
}

export interface RtcEnv {
  RTCPeerConnection: typeof RTCPeerConnection
  gatherTimeoutMs?: number
}

/** Waits for complete ICE gathering, or settles for what was gathered after the timeout. */
async function gathered(pc: RTCPeerConnection, timeoutMs: number): Promise<string> {
  if (pc.iceGatheringState !== 'complete')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState !== 'complete') return
        clearTimeout(timer)
        resolve()
      })
    })
  const sdp = pc.localDescription?.sdp
  if (!sdp) throw new PairingError('No local description')
  return sdp
}

function openLink(
  pc: RTCPeerConnection,
  dc: RTCDataChannel,
  code: string,
  role: 'host' | 'guest',
  offerFp: Uint8Array,
  answerFp: Uint8Array,
): Promise<PeerLink> {
  const texts: string[] = []
  let textWaiter: ((s: string) => void) | null = null
  let failWaiter: ((e: Error) => void) | null = null
  dc.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return
    if (textWaiter) {
      const w = textWaiter
      textWaiter = null
      failWaiter = null
      w(e.data)
    } else texts.push(e.data)
  })
  dc.addEventListener('close', () => failWaiter?.(new PairingError('Channel closed during pairing')))
  const nextText = (): Promise<string> => {
    const t = texts.shift()
    if (t !== undefined) return Promise.resolve(t)
    return new Promise((resolve, reject) => {
      textWaiter = resolve
      failWaiter = reject
    })
  }
  const frames = dataChannelFrames(dc)
  const close = () => {
    dc.close()
    pc.close()
  }

  return new Promise<void>((resolve, reject) => {
    if (dc.readyState === 'open') return resolve()
    dc.addEventListener('open', () => resolve())
    dc.addEventListener('error', () => reject(new PairingError('Channel failed to open')))
  }).then(async () => {
    const other = role === 'host' ? 'guest' : 'host'
    dc.send(await pairingProof(code, role, offerFp, answerFp))
    const expected = await pairingProof(code, other, offerFp, answerFp)
    if (!sameText(await nextText(), expected)) {
      close()
      throw new PairingError('The other device does not know the pairing code')
    }
    return {
      frames,
      sendBundle: (b) => dc.send(JSON.stringify(b)),
      receiveBundle: async () => JSON.parse(await nextText()) as PairingBundle,
      close,
    }
  })
}

function newConnection(env: RtcEnv): { pc: RTCPeerConnection; dc: RTCDataChannel } {
  // No iceServers: LAN only by default.
  const pc = new env.RTCPeerConnection({ iceServers: [] })
  const dc = pc.createDataChannel('cursus', { negotiated: true, id: 0, ordered: true })
  return { pc, dc }
}

/** Host side: returns the offer text to show, and completes once the guest's answer is entered. */
export async function hostPairing(
  env: RtcEnv,
  code: string,
): Promise<{ offer: string; complete(answer: string): Promise<PeerLink> }> {
  normalisePairingCode(code)
  const { pc, dc } = newConnection(env)
  await pc.setLocalDescription(await pc.createOffer())
  const offer = minimiseSdp('offer', await gathered(pc, env.gatherTimeoutMs ?? GATHER_TIMEOUT_MS))
  return {
    offer: encodeSignal(offer),
    async complete(answerText) {
      const answer = decodeSignal(answerText)
      if (answer.type !== 'answer') throw new PairingError('Expected an answer')
      const link = openLink(pc, dc, code, 'host', offer.fingerprint, answer.fingerprint)
      await pc.setRemoteDescription(rebuildSdp(answer))
      return link
    },
  }
}

/** Guest side: takes the host's offer, returns the answer text and the link once open. */
export async function joinPairing(
  env: RtcEnv,
  code: string,
  offerText: string,
): Promise<{ answer: string; link: Promise<PeerLink> }> {
  normalisePairingCode(code)
  const offer = decodeSignal(offerText)
  if (offer.type !== 'offer') throw new PairingError('Expected an offer')
  const { pc, dc } = newConnection(env)
  await pc.setRemoteDescription(rebuildSdp(offer))
  await pc.setLocalDescription(await pc.createAnswer())
  const answer = minimiseSdp('answer', await gathered(pc, env.gatherTimeoutMs ?? GATHER_TIMEOUT_MS))
  const link = openLink(pc, dc, code, 'guest', offer.fingerprint, answer.fingerprint)
  return { answer: encodeSignal(answer), link }
}
