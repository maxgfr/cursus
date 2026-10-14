import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { simulate, simulationArb } from './actions'

/** Seeds that once failed `sync.property.test.ts`, replayed exactly (seed + shrink path). */
const PINNED: { seed: number; path: string; why: string }[] = [
  {
    seed: 1317947810,
    path: '752:0:3:3:8:8:8:8:11:8:9:14:13:16:17:3:15:16:2:0:0:2:14:15:14:14:14:14:14:14:14:15:20:19:20:21:21:21:21:21:21:21:21:21:19:19:19:19:19:19:19:19:19:19:19:19:19:19:19',
    why: 'sealing an existing destination copied a manifest whose chunk read back corrupt (I2)',
  },
  {
    seed: -1984421989,
    path: '25:0:1:1:1:1:1:1:1:1:1:3:1:6:5:6:14:14:0:8:7:8:12:12:12:3:7:6:5:5:7:7:7:7:7:7:7:7:7:7:7:7:7:7:7:7',
    why: 'crash between two captured edits must not persist the second without the first (I4)',
  },
  {
    seed: -1315970622,
    path: '148:0:0:0:0:0:0:0:0:1:0:3:2:2:6:6:6:6:6:6:6:6:6:6:6:6:6:6:6:6:6:6:6:6',
    why: 'a fresh device restored while a destination is being sealed',
  },
  {
    seed: -1997441400,
    path: '66:0:0:0:0:0:0:0:0:2:0:0:3:4:7:7:5:5:5:5:5:5:5:5:5',
    why: 'a fresh device is usable only once booted, then crashes after a void',
  },
]

for (const p of PINNED) {
  test(`regression: ${p.why} (seed ${p.seed})`, async () => {
    const out = await fc.check(
      fc.asyncProperty(simulationArb, async (sim) => {
        await simulate(sim)
      }),
      { seed: p.seed, path: p.path, endOnFailure: true },
    )
    if (out.failed) console.error(fc.defaultReportMessage(out), out.errorInstance)
    expect(out.failed).toBe(false)
  }, 120_000)
}
