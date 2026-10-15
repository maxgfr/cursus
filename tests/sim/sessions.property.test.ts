import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { sessionSimulationArb, simulate } from './actions'

const RUNS = Number(process.env.FC_RUNS ?? 100)

/**
 * Study sessions under sync: practice and counted sessions on every device, often over the same cards, ended on
 * two devices, plans created and edited concurrently, through faulty destinations. Converged tabs agree on every
 * session and its history, practice reviews never move the FSRS schedule yet count in the statistics, and I1–I12
 * still hold (I13). A failure prints its seed and path: pin them in regressions.test.ts.
 */
test('sessions: practice never moves the schedule, sessions and plans converge (I1–I13)', async () => {
  const out = await fc.check(
    fc.asyncProperty(sessionSimulationArb, async (sim) => {
      await simulate(sim)
    }),
    { numRuns: RUNS },
  )
  if (out.failed) {
    console.error(`FAILING SEED: { seed: ${out.seed}, path: '${out.counterexamplePath}' }`)
    console.error(fc.defaultReportMessage(out), out.errorInstance)
  }
  expect(out.failed).toBe(false)
}, 300_000)
