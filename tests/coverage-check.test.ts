import { describe, expect, test } from 'bun:test'
import { checkCoverage } from '../scripts/coverage-check'

const rec = (sf: string, lh: number, lf: number): string => `SF:${sf}\nLF:${lf}\nLH:${lh}\nend_of_record\n`

describe('checkCoverage', () => {
  test('fails when a directory is below threshold', () => {
    const r = checkCoverage(rec('src/core/log/a.ts', 8, 10) + rec('src/core/log/b.ts', 9, 10), ['src/core/log'])
    expect(r.ok).toBe(false)
    expect(r.results[0]).toMatchObject({ status: 'fail', hit: 17, found: 20 })
  })
  test('passes when at or above threshold', () => {
    const r = checkCoverage(rec('src/core/srs/a.ts', 19, 20), ['src/core/srs'])
    expect(r.ok).toBe(true)
    expect(r.results[0]).toMatchObject({ status: 'ok' })
  })
  test('skips directories absent from the report', () => {
    const r = checkCoverage(rec('src/ui/x.ts', 0, 10), ['src/core/sync'])
    expect(r.ok).toBe(true)
    expect(r.results[0]).toEqual({ dir: 'src/core/sync', status: 'absent' })
  })
})
