import { describe, expect, test } from 'bun:test'
import { ONBOARDED_KEY } from '../../../app/onboarding.ts'
import { CHAT_EXPANDED_KEY, CHAT_WIDTH_KEY } from '../../../ui/chat/chatWidth.ts'
import { SHOW_MARKDOWN_KEY } from '../../../ui/editor/prefs.ts'
import { LAST_QUIZ_KEY } from '../../Sessions/quizLast.ts'
import { keysToErase } from './erase'

describe('erasing the device', () => {
  test('every key of the app goes, whatever wrote it; nothing else does', () => {
    const ours = [
      ONBOARDED_KEY,
      SHOW_MARKDOWN_KEY,
      LAST_QUIZ_KEY,
      CHAT_WIDTH_KEY,
      CHAT_EXPANDED_KEY,
      'cursus:pendingBack',
      'cursus:new',
    ]
    const theirs = ['other', 'cursus', 'cursusX', 'cursus-v1', 'my:cursus:key', '']
    expect(keysToErase([...theirs, ...ours])).toEqual(ours)
    expect(keysToErase([])).toEqual([])
  })
})
