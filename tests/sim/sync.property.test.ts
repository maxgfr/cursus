import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { extendedSimulationArb, simulate } from './actions'

const RUNS = Number(process.env.FC_RUNS ?? 100)

/**
 * "Nothing is ever lost": 2–4 devices (tabs, crashes, clones, fresh restores), 1–3 faulty
 * destinations (+ a sealed copy), every interleaving chosen by fc.scheduler, then a heal phase and
 * invariants I1–I12. A failure prints its seed and path: pin them in regressions.test.ts.
 */
test('sync: nothing is ever lost (I1–I12)', async () => {
  const out = await fc.check(
    fc.asyncProperty(extendedSimulationArb, async (sim) => {
      await simulate(sim)
    }),
    { numRuns: RUNS },
  )
  if (out.failed) {
    console.error(`FAILING SEED: { seed: ${out.seed}, path: '${out.counterexamplePath}' }`)
    console.error(fc.defaultReportMessage(out), out.errorInstance)
  }
  expect(out.failed).toBe(false)
}, 120_000)
