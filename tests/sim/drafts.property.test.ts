import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { draftSimulationArb, simulate } from './actions'

const RUNS = Number(process.env.FC_RUNS ?? 100)

/**
 * Proposed questions under sync: drafts proposed, accepted, rejected and edited on every device, often the same
 * draft concurrently, through faulty destinations. Converged tabs derive the same drafts, groups and Today line;
 * an acknowledged rejection never comes back; every card an acceptance created is kept with its provenance; and
 * I1–I13 still hold (I14). A failure prints its seed and path: pin them in regressions.test.ts.
 */
test('drafts: converge, rejected never come back, accepted cards are kept (I1–I14)', async () => {
  const out = await fc.check(
    fc.asyncProperty(draftSimulationArb, async (sim) => {
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
