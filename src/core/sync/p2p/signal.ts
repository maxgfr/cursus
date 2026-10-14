/**
 * Serverless WebRTC signalling: an offer or answer is shrunk to what the other side cannot guess
 * (ICE ufrag and pwd, DTLS fingerprint, setup role, candidates), carried as text or a QR code, and
 * rebuilt into a full data-channel SDP on arrival. No STUN: only the candidates the browser gathers
 * on the LAN travel.
 *
 * Wire form: `C1|<o|a>|<ufrag>|<pwd>|<fingerprint base64url>|<setup>|<cand>,<cand>` where a
 * candidate is `<udp|tcp>_<address>_<port>_<priority>_<type>`.
 */

export type SignalType = 'offer' | 'answer'
export type SetupRole = 'actpass' | 'active' | 'passive'

export interface Candidate {
  protocol: 'udp' | 'tcp'
  address: string
  port: number
  priority: number
  type: string
}

export interface MinimalSignal {
  type: SignalType
  ufrag: string
  pwd: string
  /** SHA-256 DTLS certificate fingerprint, 32 bytes. */
  fingerprint: Uint8Array
  setup: SetupRole
  candidates: Candidate[]
}

export class SignalError extends Error {}

const VERSION = 'C1'
const SETUP_CODE: Record<SetupRole, string> = { actpass: 'x', active: 'a', passive: 'p' }

function line(sdp: string, prefix: string): string | undefined {
  for (const l of sdp.split(/\r?\n/)) if (l.startsWith(prefix)) return l.slice(prefix.length).trim()
  return undefined
}

function required(sdp: string, prefix: string): string {
  const v = line(sdp, prefix)
  if (v === undefined || v === '') throw new SignalError(`SDP has no ${prefix}`)
  return v
}

function parseCandidate(text: string): Candidate | null {
  // candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
  const f = text.replace(/^candidate:/, '').split(' ')
  const [, component, protocol, priority, address, port, typ, type] = f
  if (component !== '1' || typ !== 'typ' || !address || !type) return null
  const proto = protocol?.toLowerCase()
  if (proto !== 'udp' && proto !== 'tcp') return null
  // TCP candidates need a tcptype the minimal form does not carry; passive ones are useless anyway.
  if (proto === 'tcp') return null
  return { protocol: proto, address, port: Number(port), priority: Number(priority), type }
}

/** Extracts the minimal signal from a browser-made SDP (full ICE gathering expected). */
export function minimiseSdp(type: SignalType, sdp: string): MinimalSignal {
  const fp = required(sdp, 'a=fingerprint:').split(' ')
  if (fp[0]?.toLowerCase() !== 'sha-256' || !fp[1]) throw new SignalError('Only sha-256 fingerprints are supported')
  const hex = fp[1].split(':')
  if (hex.length !== 32) throw new SignalError('Malformed fingerprint')
  const fingerprint = new Uint8Array(hex.map((h) => Number.parseInt(h, 16)))
  const setup = required(sdp, 'a=setup:') as SetupRole
  if (!(setup in SETUP_CODE)) throw new SignalError(`Unknown setup role ${setup}`)
  const candidates: Candidate[] = []
  for (const l of sdp.split(/\r?\n/)) {
    if (!l.startsWith('a=candidate:')) continue
    const c = parseCandidate(l.slice(2).trim())
    if (c) candidates.push(c)
  }
  return {
    type,
    ufrag: required(sdp, 'a=ice-ufrag:'),
    pwd: required(sdp, 'a=ice-pwd:'),
    fingerprint,
    setup,
    candidates,
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export function encodeSignal(m: MinimalSignal): string {
  const cands = m.candidates.map((c) => [c.protocol, c.address, c.port, c.priority, c.type].join('_')).join(',')
  return [
    VERSION,
    m.type === 'offer' ? 'o' : 'a',
    m.ufrag,
    m.pwd,
    toBase64Url(m.fingerprint),
    SETUP_CODE[m.setup],
    cands,
  ].join('|')
}

export function decodeSignal(text: string): MinimalSignal {
  const parts = text.trim().split('|')
  if (parts.length !== 7 || parts[0] !== VERSION) throw new SignalError('Not a Cursus signal')
  const [, t, ufrag = '', pwd = '', fp = '', s, cands = ''] = parts
  if (t !== 'o' && t !== 'a') throw new SignalError('Unknown signal type')
  const setup = (Object.keys(SETUP_CODE) as SetupRole[]).find((k) => SETUP_CODE[k] === s)
  if (!setup) throw new SignalError('Unknown setup role')
  let fingerprint: Uint8Array
  try {
    fingerprint = fromBase64Url(fp)
  } catch {
    throw new SignalError('Malformed fingerprint')
  }
  if (fingerprint.length !== 32 || !ufrag || !pwd) throw new SignalError('Incomplete signal')
  const candidates: Candidate[] = []
  for (const c of cands === '' ? [] : cands.split(',')) {
    const [protocol, address, port, priority, type] = c.split('_')
    if ((protocol !== 'udp' && protocol !== 'tcp') || !address || !type) throw new SignalError('Malformed candidate')
    const p = Number(port)
    const prio = Number(priority)
    if (!Number.isInteger(p) || !Number.isInteger(prio)) throw new SignalError('Malformed candidate')
    candidates.push({ protocol, address, port: p, priority: prio, type })
  }
  return { type: t === 'o' ? 'offer' : 'answer', ufrag, pwd, fingerprint, setup, candidates }
}

export function fingerprintHex(fp: Uint8Array): string {
  return Array.from(fp, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':')
}

/** Rebuilds a data-channel SDP the browser accepts as remote description. */
export function rebuildSdp(m: MinimalSignal): { type: SignalType; sdp: string } {
  const lines = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...m.candidates.map(
      (c, i) => `a=candidate:${i + 1} 1 ${c.protocol} ${c.priority} ${c.address} ${c.port} typ ${c.type}`,
    ),
    'a=end-of-candidates',
    `a=ice-ufrag:${m.ufrag}`,
    `a=ice-pwd:${m.pwd}`,
    `a=fingerprint:sha-256 ${fingerprintHex(m.fingerprint)}`,
    `a=setup:${m.setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ]
  return { type: m.type, sdp: `${lines.join('\r\n')}\r\n` }
}
