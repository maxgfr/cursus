import { describe, expect, test } from 'bun:test'
import { CODE_BITS, newPairingCode, normalisePairingCode, PairingError, pairingProof } from './pairing'

const fpA = new Uint8Array(32).fill(1)
const fpB = new Uint8Array(32).fill(2)

describe('pairing codes', () => {
  test('a typed code carries at least 60 bits', () => {
    expect(CODE_BITS).toBeGreaterThanOrEqual(60)
    const code = newPairingCode()
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{5}$/)
    expect(new Set(Array.from({ length: 50 }, () => newPairingCode())).size).toBe(50)
  })

  test('normalising forgives case, dashes, spaces and look-alikes', () => {
    const code = newPairingCode(() => new Uint8Array(13).fill(0))
    expect(code).toBe('0000-0000-00000')
    expect(normalisePairingCode('oooo 0000-ilil0')).toBe('0000000011110')
    expect(normalisePairingCode('abcd-efgh-jkmnp')).toBe('ABCDEFGHJKMNP')
    expect(() => normalisePairingCode('ABC')).toThrow(PairingError)
    expect(() => normalisePairingCode('ABCD-EFGH-JKMNU')).toThrow(PairingError)
  })
})

describe('pairing proof', () => {
  test('depends on the code, the role and both fingerprints', async () => {
    const base = await pairingProof('ABCD-EFGH-JKMNP', 'host', fpA, fpB)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(await pairingProof('abcdefghjkmnp', 'host', fpA, fpB)).toBe(base)
    expect(await pairingProof('ABCD-EFGH-JKMNQ', 'host', fpA, fpB)).not.toBe(base)
    expect(await pairingProof('ABCD-EFGH-JKMNP', 'guest', fpA, fpB)).not.toBe(base)
    expect(await pairingProof('ABCD-EFGH-JKMNP', 'host', fpB, fpA)).not.toBe(base)
  })
})
