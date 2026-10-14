import { expect, test } from 'bun:test'
import { createTranslator, loadCatalog } from '../../i18n/index.ts'
import { describeFailure } from './failure.ts'

test('failures read as a plain explanation plus the next step, never the raw exception', async () => {
  await loadCatalog('en')
  const t = createTranslator('en')
  const raw = new Error('TypeError: undefined is not an object (evaluating x.y)')
  const generic = describeFailure(raw, t, true)
  expect(generic).not.toContain('undefined')
  expect(generic).toContain('Try again')
  const quota = new Error('x')
  quota.name = 'QuotaExceededError'
  expect(describeFailure(quota, t, true)).toContain('Free up some space')
  expect(describeFailure(raw, t, false)).toContain('Check your connection')
  expect(describeFailure(new TypeError('Failed to fetch'), t, true)).toContain('Check your connection')
  expect(describeFailure({ statusCode: 401 }, t, true)).toContain('Check the key in Settings, AI.')
  expect(describeFailure({ statusCode: 429 }, t, true)).toContain('Wait a minute')
  expect(describeFailure({ statusCode: 402 }, t, true)).toContain('Add credit')
  expect(describeFailure('boom', t, true)).toContain('Something went wrong.')
})
