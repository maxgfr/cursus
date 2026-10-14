import { expect, test } from 'bun:test'
import { ALARM_AFTER_MS, computeStatus, type DestRuntime } from './status'

const rt = (id: string, extra: Partial<DestRuntime> = {}): DestRuntime => ({
  id,
  label: id,
  state: 'ok',
  incoming: 0,
  corrupt: 0,
  ...extra,
})

test('safe only when every local key is confirmed somewhere and nothing is unsealed', () => {
  const local = new Set(['a', 'b'])
  const base = { now: 10, local, seen: { a: 1, b: 2 }, unsealed: 0, needsUpgrade: 0 }
  expect(computeStatus({ ...base, dests: [] }).safe).toBe(false)
  const split = computeStatus({
    ...base,
    dests: [
      { runtime: rt('x'), confirmed: new Set(['a']) },
      {
        runtime: rt('y', {
          lastOkAt: 5,
          nextTryAt: 9,
          lastVerifiedAt: 3,
          reason: 'corrupt',
          error: { kind: 'network', message: 'm', at: 1 },
        }),
        confirmed: new Set(['b']),
      },
    ],
  })
  expect(split).toMatchObject({ safe: true, protectedOn: 0, alarm: false })
  expect(split.dests[0]).toMatchObject({ unconfirmed: 1, oldestUnconfirmedAt: 2 })
  expect(split.dests[1]).toMatchObject({
    unconfirmed: 1,
    oldestUnconfirmedAt: 1,
    lastOkAt: 5,
    nextTryAt: 9,
    lastVerifiedAt: 3,
    reason: 'corrupt',
  })
  const one = computeStatus({ ...base, unsealed: 1, dests: [{ runtime: rt('x'), confirmed: new Set(['a', 'b']) }] })
  expect(one).toMatchObject({ safe: false, protectedOn: 1, unsealed: 1 })
  expect(one.dests[0]?.oldestUnconfirmedAt).toBeUndefined()
})

test('red banner when a key is confirmed nowhere for more than 24 h', () => {
  const s = (now: number) =>
    computeStatus({
      now,
      local: new Set(['k']),
      seen: { k: 0 },
      unsealed: 0,
      needsUpgrade: 2,
      dests: [{ runtime: rt('x'), confirmed: new Set() }],
    })
  expect(s(ALARM_AFTER_MS).alarm).toBe(false)
  expect(s(ALARM_AFTER_MS + 1).alarm).toBe(true)
  expect(s(1).needsUpgrade).toBe(2)
  expect(
    computeStatus({ now: 5, local: new Set(['new']), seen: {}, unsealed: 0, needsUpgrade: 0, dests: [] }).alarm,
  ).toBe(false)
})

test('captured edits not yet acknowledged by the local log are never safe', () => {
  const s = computeStatus({
    now: 1,
    local: new Set(['a']),
    seen: { a: 0 },
    unsealed: 0,
    needsUpgrade: 0,
    unsaved: 3,
    dests: [{ runtime: rt('x'), confirmed: new Set(['a']) }],
  })
  expect(s).toMatchObject({ safe: false, unsaved: 3, unsealed: 3, protectedOn: 1 })
})
