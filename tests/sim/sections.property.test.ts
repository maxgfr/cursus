import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { sectionSimulationArb, simulate } from './actions'

const RUNS = Number(process.env.FC_RUNS ?? 100)

/**
 * Subsets edited on every device while offline (create, rename, move, trash/restore/purge, file items), then
 * synced through faulty destinations: every converged tab derives the same acyclic tree, nothing acknowledged is
 * lost, and I1–I11 still hold (I12). A failure prints its seed and path: pin them in regressions.test.ts.
 */
test('sections: concurrent moves converge to one acyclic tree, nothing lost (I1–I12)', async () => {
  const out = await fc.check(
    fc.asyncProperty(sectionSimulationArb, async (sim) => {
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
