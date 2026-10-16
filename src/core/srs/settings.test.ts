import { describe, expect, test } from 'bun:test'
import type { StepUnit } from 'ts-fsrs'
import { createScheduler, DAY_MS, DEFAULT_PARAMS, paramsKey } from './fsrs'
import {
  formatSteps,
  parseSteps,
  previewSamples,
  previewSources,
  queueLimitsOf,
  REVIEW_DEFAULTS,
  REVIEW_SETTING_KEYS,
  type ReviewSettingKey,
  STEPS_MAX,
  sameSetting,
  srsParamsOf,
  validReviewSetting,
} from './settings'

const NOW = Date.UTC(2026, 9, 16, 9)
const MIN = 60_000

describe('steps', () => {
  test('written as Anki writes them: minutes, hours, days, spaces or commas between', () => {
    expect(parseSteps('1m 10m')).toEqual(['1m', '10m'])
    expect(parseSteps(' 2M,15m  1h ')).toEqual(['2m', '15m', '1h'])
    expect(parseSteps('1d')).toEqual(['1d'])
    expect(parseSteps('')).toEqual([])
    expect(parseSteps('   ')).toEqual([])
    expect(formatSteps(['1m', '10m'])).toBe('1m 10m')
    expect(formatSteps([])).toBe('')
  })

  test('not a step: no unit, seconds, zero, a fraction, longer than a day, too many', () => {
    for (const bad of ['10', '30s', '0m', '1.5m', '-1m', '25h', '2d', 'm', '1m 10x'])
      expect([bad, parseSteps(bad)]).toEqual([bad, null])
    expect(parseSteps(Array.from({ length: STEPS_MAX }, () => '1m').join(' '))).toHaveLength(STEPS_MAX)
    expect(parseSteps(Array.from({ length: STEPS_MAX + 1 }, () => '1m').join(' '))).toBeNull()
  })
})

describe('the settings', () => {
  test('the defaults are the recommended ones, and the scheduler they make is the one of the retention alone', () => {
    expect(srsParamsOf(REVIEW_DEFAULTS)).toEqual(DEFAULT_PARAMS)
    expect(paramsKey(srsParamsOf(REVIEW_DEFAULTS))).toBe(paramsKey(DEFAULT_PARAMS))
    expect(createScheduler(srsParamsOf({ ...REVIEW_DEFAULTS, desiredRetention: 0.85 }))).toBe(
      createScheduler({ desiredRetention: 0.85 }),
    )
    for (const k of REVIEW_SETTING_KEYS) expect([k, validReviewSetting(k, REVIEW_DEFAULTS[k])]).toEqual([k, true])
    expect(Object.isFrozen(REVIEW_DEFAULTS)).toBe(true)
  })

  test('what each setting accepts', () => {
    const cases: [ReviewSettingKey, unknown, boolean][] = [
      ['dailyNewCards', 0, true],
      ['dailyNewCards', 9999, true],
      ['dailyNewCards', 10000, false],
      ['dailyNewCards', 1.5, false],
      ['dailyNewCards', '20', false],
      ['dailyNewCards', -1, false],
      ['maxReviewsPerDay', null, true],
      ['maxReviewsPerDay', 1, true],
      ['maxReviewsPerDay', 0, false],
      ['maxReviewsPerDay', Number.POSITIVE_INFINITY, false],
      ['desiredRetention', 0.7, true],
      ['desiredRetention', 0.97, true],
      ['desiredRetention', 0.98, false],
      ['desiredRetention', 0.69, false],
      ['desiredRetention', Number.NaN, false],
      ['learningSteps', ['1m', '10m'], true],
      ['learningSteps', [], true],
      ['learningSteps', ['10'], false],
      ['learningSteps', '1m 10m', false],
      ['learningSteps', ['1M'], false],
      ['relearningSteps', ['10m'], true],
      ['relearningSteps', [1], false],
      ['maximumInterval', 1, true],
      ['maximumInterval', 36500, true],
      ['maximumInterval', 36501, false],
      ['enableFuzz', false, true],
      ['enableFuzz', 'no', false],
      ['newOrder', 'random', true],
      ['newOrder', 'due', false],
      ['newMix', 'mixed', true],
      ['newMix', 'before', true],
      ['newMix', 'first', false],
      ['leechThreshold', 1, true],
      ['leechThreshold', 99, true],
      ['leechThreshold', 100, false],
      ['leechAction', 'suspend', true],
      ['leechAction', 'delete', false],
    ]
    for (const [k, v, ok] of cases) expect([k, v, validReviewSetting(k, v)]).toEqual([k, v, ok])
  })

  test('steps compare as written; other settings by value', () => {
    expect(sameSetting('learningSteps', ['1m', '10m'], ['1m', '10m'])).toBe(true)
    expect(sameSetting('learningSteps', ['1m'], ['1m', '10m'])).toBe(false)
    expect(sameSetting('relearningSteps', '10m', ['10m'])).toBe(false)
    expect(sameSetting('dailyNewCards', 20, 20)).toBe(true)
    expect(sameSetting('maxReviewsPerDay', null, 100)).toBe(false)
  })

  test('the queue gets only what differs from the default order', () => {
    expect(queueLimitsOf(REVIEW_DEFAULTS)).toEqual({ newPerDay: 20 })
    expect(queueLimitsOf({ dailyNewCards: 5, maxReviewsPerDay: 100, newOrder: 'random', newMix: 'before' })).toEqual({
      newPerDay: 5,
      maxReviews: 100,
      newOrder: 'random',
      newMix: 'before',
    })
  })
})

describe('the preview', () => {
  test('with the recommended settings: 1 min / 6 min / 10 min / 8 d on a new card, 10 min / 7 d / 9 d / 13 d on a review', () => {
    const { fresh, review } = previewSamples(DEFAULT_PARAMS, NOW)
    expect(fresh).toEqual({ 1: MIN, 2: 6 * MIN, 3: 10 * MIN, 4: 8 * DAY_MS })
    expect(review).toEqual({ 1: 10 * MIN, 2: 7 * DAY_MS, 3: 9 * DAY_MS, 4: 13 * DAY_MS })
  })

  test('follows the steps, the retention and the maximum; never the variation', () => {
    const steps = previewSamples({ ...DEFAULT_PARAMS, learningSteps: ['2m', '15m'], relearningSteps: ['5m'] }, NOW)
    expect(steps.fresh[1]).toBe(2 * MIN)
    expect(steps.fresh[3]).toBe(15 * MIN)
    expect(steps.review[1]).toBe(5 * MIN)
    const lower = previewSamples({ ...DEFAULT_PARAMS, desiredRetention: 0.8 }, NOW)
    expect(lower.review[3]).toBeGreaterThan(9 * DAY_MS)
    // The maximum caps the waits (each button still at least a day after the one before, as FSRS keeps them).
    const capped = previewSamples({ ...DEFAULT_PARAMS, maximumInterval: 5 }, NOW)
    expect(capped.fresh[4]).toBe(5 * DAY_MS)
    expect([capped.review[2], capped.review[3], capped.review[4]]).toEqual([5 * DAY_MS, 6 * DAY_MS, 7 * DAY_MS])
    expect(previewSamples({ ...DEFAULT_PARAMS, enableFuzz: true }, NOW)).toEqual(previewSamples(DEFAULT_PARAMS, NOW))
  })

  test('says what sets each wait: a step gives minutes as written, FSRS whole days', () => {
    const cases: [StepUnit[], StepUnit[]][] = [
      [['1m', '10m'], ['10m']],
      [
        ['2m', '15m', '1h'],
        ['5m', '20m'],
      ],
      [['5m'], []],
      [[], ['10m']],
      [[], []],
    ]
    for (const [learningSteps, relearningSteps] of cases) {
      const params = { ...DEFAULT_PARAMS, learningSteps, relearningSteps }
      const waits = previewSamples(params, NOW)
      const sources = previewSources(params)
      for (const sample of ['fresh', 'review'] as const) {
        for (const r of [1, 2, 3, 4] as const) {
          const wait = waits[sample][r]
          const fromStep = sources[sample][r] !== 'retention'
          expect([learningSteps, relearningSteps, sample, r, wait < DAY_MS]).toEqual([
            learningSteps,
            relearningSteps,
            sample,
            r,
            fromStep,
          ])
          if (!fromStep) expect(wait % DAY_MS).toBe(0)
        }
      }
    }
    expect(previewSources(DEFAULT_PARAMS)).toEqual({
      fresh: { 1: 'learningSteps', 2: 'learningSteps', 3: 'learningSteps', 4: 'retention' },
      review: { 1: 'relearningSteps', 2: 'retention', 3: 'retention', 4: 'retention' },
    })
    // One step: Hard waits half as long again, Good graduates.
    const one = previewSamples({ ...DEFAULT_PARAMS, learningSteps: ['10m'] }, NOW)
    expect([one.fresh[1], one.fresh[2]]).toEqual([10 * MIN, 15 * MIN])
    expect(previewSources({ learningSteps: ['10m'], relearningSteps: [] }).fresh[3]).toBe('retention')
  })
})
