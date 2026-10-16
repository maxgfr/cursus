import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import { createScheduler } from '../srs/fsrs'
import { REVIEW_DEFAULTS, REVIEW_SETTING_KEYS } from '../srs/settings'
import { canonicalJson } from '../sync/verify'
import { queueLimitsFor, ReviewSettingsError, reviewKey, schedulerOf } from './reviewSettings'
import { ROOT } from './schema'
import { createWorkspace } from './workspace'

function make(seed = 1) {
  const doc = new Y.Doc()
  const clock = virtualClock(Date.UTC(2026, 9, 16))
  const ws = createWorkspace(doc, { rng: seededRng(seed, clock), clock, deviceId: `d${seed}` })
  return { doc, ws, prefs: doc.getMap<unknown>(ROOT.prefs) }
}

function sync(a: Y.Doc, b: Y.Doc): void {
  const ua = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b))
  const ub = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a))
  Y.applyUpdateV2(b, ua)
  Y.applyUpdateV2(a, ub)
}

describe('the review settings', () => {
  test('nothing is written until a setting changes: a new library reads the recommended settings', () => {
    const { doc, ws } = make()
    const sv = Y.encodeStateVector(doc)
    expect(ws.reviewSettings.get()).toEqual({ ...REVIEW_DEFAULTS })
    schedulerOf(ws)
    queueLimitsFor(ws)
    expect(Buffer.from(Y.encodeStateVector(doc)).equals(Buffer.from(sv))).toBe(true)
    expect(canonicalJson(doc)).toBe('{}')
  })

  test('one key per setting, steps kept as written; the two older ones under their own names', () => {
    const { ws, prefs } = make()
    ws.reviewSettings.set({
      dailyNewCards: 15,
      desiredRetention: 0.85,
      learningSteps: ['2m', '15m'],
      relearningSteps: [],
      maxReviewsPerDay: 200,
      newMix: 'mixed',
    })
    expect(Object.fromEntries(prefs.entries())).toEqual({
      dailyNewCards: 15,
      desiredRetention: 0.85,
      'review.learningSteps': '2m 15m',
      'review.relearningSteps': '',
      'review.maxReviewsPerDay': 200,
      'review.newMix': 'mixed',
    })
    expect(ws.reviewSettings.get()).toMatchObject({
      dailyNewCards: 15,
      desiredRetention: 0.85,
      learningSteps: ['2m', '15m'],
      relearningSteps: [],
      maxReviewsPerDay: 200,
      newMix: 'mixed',
    })
    // Older code reading the prefs directly sees the same two.
    expect(ws.prefs.get('dailyNewCards')).toBe(15)
    expect(reviewKey('leechAction')).toBe('review.leechAction')
  })

  test('put back to its default, a setting gives its key up; reset removes them all', () => {
    const { ws, prefs } = make()
    ws.reviewSettings.set({ dailyNewCards: 15, learningSteps: ['5m'], maxReviewsPerDay: 50, leechThreshold: 4 })
    ws.reviewSettings.set({ dailyNewCards: 20, learningSteps: ['1m', '10m'], maxReviewsPerDay: null })
    expect([...prefs.keys()]).toEqual(['review.leechThreshold'])
    ws.reviewSettings.set({ leechThreshold: undefined })
    expect(prefs.size).toBe(0)
    ws.reviewSettings.set({ desiredRetention: 0.8, enableFuzz: false, newOrder: 'random', leechAction: 'suspend' })
    ws.reviewSettings.reset()
    expect(prefs.size).toBe(0)
    expect(ws.reviewSettings.get()).toEqual({ ...REVIEW_DEFAULTS })
  })

  test('a value that is not one reads as the default, whoever wrote it; one given is refused, nothing written', () => {
    const { ws, prefs } = make()
    prefs.set('dailyNewCards', '20')
    prefs.set('desiredRetention', 1.2)
    prefs.set('review.learningSteps', '10 seconds')
    prefs.set('review.relearningSteps', ['10m'])
    prefs.set('review.maxReviewsPerDay', -3)
    prefs.set('review.newOrder', 'due')
    prefs.set('review.leechThreshold', 8.5)
    expect(ws.reviewSettings.get()).toEqual({ ...REVIEW_DEFAULTS })
    const before = Object.fromEntries(prefs.entries())
    expect(() => ws.reviewSettings.set({ dailyNewCards: 5, leechThreshold: 0 })).toThrow(ReviewSettingsError)
    expect(() => ws.reviewSettings.set({ learningSteps: ['30s' as '1m'] })).toThrow(ReviewSettingsError)
    expect(() => ws.reviewSettings.set({ nope: 1 } as never)).toThrow(ReviewSettingsError)
    expect(Object.fromEntries(prefs.entries())).toEqual(before)
  })

  test('two devices changing two settings both keep their change', () => {
    const a = make(1)
    const b = make(2)
    a.ws.reviewSettings.set({ learningSteps: ['2m', '15m'] })
    b.ws.reviewSettings.set({ maxReviewsPerDay: 100 })
    sync(a.doc, b.doc)
    for (const { ws } of [a, b]) {
      expect(ws.reviewSettings.get()).toMatchObject({ learningSteps: ['2m', '15m'], maxReviewsPerDay: 100 })
    }
  })

  test('the scheduler of the settings: with the retention alone, the very one of the retention', () => {
    const { ws } = make()
    expect(schedulerOf(ws)).toBe(createScheduler({ desiredRetention: 0.9 }))
    ws.reviewSettings.set({ desiredRetention: 0.87 })
    expect(schedulerOf(ws)).toBe(createScheduler({ desiredRetention: 0.87 }))
    ws.reviewSettings.set({ learningSteps: ['3m'], maximumInterval: 365, enableFuzz: false })
    const custom = schedulerOf(ws)
    expect(custom).not.toBe(createScheduler({ desiredRetention: 0.87 }))
    expect(custom.params).toEqual({
      desiredRetention: 0.87,
      learningSteps: ['3m'],
      relearningSteps: ['10m'],
      maximumInterval: 365,
      enableFuzz: false,
    })
    expect(schedulerOf(ws)).toBe(custom)
    expect(queueLimitsFor(ws)).toEqual({ newPerDay: 20 })
  })

  test('every setting has a key of its own', () => {
    expect(new Set(REVIEW_SETTING_KEYS.map(reviewKey)).size).toBe(REVIEW_SETTING_KEYS.length)
  })
})
