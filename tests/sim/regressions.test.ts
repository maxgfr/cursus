import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { type Simulation, sectionSimulationArb, simulate, simulationArb } from './actions'

/** Seeds that once failed a simulation property, replayed exactly (seed + shrink path) on the same arbitrary. */
const PINNED: { seed: number; path: string; why: string; arb?: fc.Arbitrary<Simulation> }[] = [
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
  {
    seed: -809976919,
    path: '259:0:2:2:2:2:2:3:3:5:2:7:10:12:13:19:17:23:23:23:23:23:23:23:25:26:26:26:26:26:26:26:30:31:34:40:40:40:43:12:22:21:21:21:21:21:21:21:21:21:21:22:28:28:28:28:35:36:34:34:36:36:35:35:35:37:37:37',
    why: 'a card filed elsewhere while an update is still pending: its course is briefly missing mid-sync (I12)',
    arb: sectionSimulationArb,
  },
]

for (const p of PINNED) {
  test(`regression: ${p.why} (seed ${p.seed})`, async () => {
    const out = await fc.check(
      fc.asyncProperty(p.arb ?? simulationArb, async (sim) => {
        await simulate(sim)
      }),
      { seed: p.seed, path: p.path, endOnFailure: true },
    )
    if (out.failed) console.error(fc.defaultReportMessage(out), out.errorInstance)
    expect(out.failed).toBe(false)
  }, 120_000)
}
