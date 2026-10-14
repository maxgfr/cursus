import { describe, expect, test } from 'bun:test'
import { decodeSignal, encodeSignal, minimiseSdp, rebuildSdp, SignalError } from './signal'

const FP = Array.from({ length: 32 }, (_, i) => (i * 7 + 3).toString(16).toUpperCase().padStart(2, '0')).join(':')

// Shape of a Chrome data-channel offer after full ICE gathering.
const CHROME_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:3829170297 1 udp 2113937151 0f9e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b.local 54400 typ host generation 0 network-cost 999',
  'a=candidate:1 1 udp 2113939711 fe80::1 51000 typ host generation 0',
  'a=candidate:842163049 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0',
  'a=ice-ufrag:Ab+/',
  'a=ice-pwd:0123456789abcdefghij+/KLmn',
  'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${FP}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n')

describe('signal', () => {
  test('minimise keeps ICE credentials, fingerprint, setup and UDP candidates', () => {
    const m = minimiseSdp('offer', CHROME_OFFER)
    expect(m.ufrag).toBe('Ab+/')
    expect(m.pwd).toBe('0123456789abcdefghij+/KLmn')
    expect(m.setup).toBe('actpass')
    expect(m.fingerprint.length).toBe(32)
    expect(m.candidates.map((c) => c.address)).toEqual(['0f9e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b.local', 'fe80::1'])
  })

  test('encoded signal is small and round-trips', () => {
    const m = minimiseSdp('offer', CHROME_OFFER)
    const text = encodeSignal(m)
    expect(text.length).toBeLessThan(200)
    expect(decodeSignal(text)).toEqual(m)
  })

  test('rebuilt SDP minimises back to the same signal', () => {
    for (const type of ['offer', 'answer'] as const) {
      const m = {
        ...minimiseSdp(type, CHROME_OFFER),
        setup: type === 'offer' ? ('actpass' as const) : ('active' as const),
      }
      const rebuilt = rebuildSdp(m)
      expect(rebuilt.type).toBe(type)
      expect(rebuilt.sdp).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel')
      expect(rebuilt.sdp).toContain(`a=fingerprint:sha-256 ${FP}`)
      expect(minimiseSdp(type, rebuilt.sdp)).toEqual(m)
    }
  })

  test('malformed input is rejected', () => {
    expect(() => decodeSignal('hello')).toThrow(SignalError)
    expect(() => decodeSignal('C1|o|u|p|AAAA|x|')).toThrow(SignalError)
    expect(() => minimiseSdp('offer', 'v=0\r\n')).toThrow(SignalError)
    expect(() => minimiseSdp('offer', CHROME_OFFER.replace('sha-256', 'sha-1'))).toThrow(SignalError)
    const ok = encodeSignal(minimiseSdp('offer', CHROME_OFFER))
    expect(() => decodeSignal(ok.replace('|x|', '|q|'))).toThrow(SignalError)
    expect(() => decodeSignal(`${ok},udp_host`)).toThrow(SignalError)
  })
})
