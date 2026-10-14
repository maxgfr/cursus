import { expect, test } from 'bun:test'
import { INSTALL_HINT_SNOOZE_MS, stillDismissed } from './installSnooze.ts'

test('a dismissed install hint stays away for 7 days, then comes back', () => {
  const now = Date.UTC(2026, 9, 14)
  expect(stillDismissed(now - 1000, now)).toBe(true)
  expect(stillDismissed(now - INSTALL_HINT_SNOOZE_MS + 1, now)).toBe(true)
  expect(stillDismissed(now - INSTALL_HINT_SNOOZE_MS, now)).toBe(false)
  // The undated flag of older versions, or nothing stored: shown.
  expect(stillDismissed(true, now)).toBe(false)
  expect(stillDismissed(undefined, now)).toBe(false)
})
