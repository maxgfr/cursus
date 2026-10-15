import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { createWorkspace } from '../model/workspace'
import { virtualClock } from '../ports/clock'
import { seededRng } from '../ports/rng'
import {
  destinationOf,
  draftDuplicates,
  existingCardTexts,
  NOTE_UNIT_CHARS,
  noteUnits,
  planRun,
  type RunPlan,
  toNewDrafts,
} from './autoQuestions'
import type { DeckQuestion } from './features/deckQuestions'

function setup() {
  const clock = virtualClock(1_000)
  const ws = createWorkspace(new Y.Doc(), { rng: seededRng(3, clock), clock, deviceId: 'd' })
  const courseId = ws.courses.create({ title: 'Physiology' })
  const sectionId = ws.sections.create({ courseId, name: 'Cardio' })
  const sourceId = ws.sources.create({ courseId, sectionId, kind: 'note', title: 'Heart' })
  return { ws, courseId, sectionId, sourceId }
}

const question = (front: string, unit = 1, more: Partial<DeckQuestion> = {}): DeckQuestion => ({
  kind: 'basic',
  type: 'qa',
  difficulty: 'easy',
  front,
  back: 'b',
  unit,
  sourceRef: { sourceId: 's', page: unit },
  ...more,
})

describe('auto questions: notes as units', () => {
  test('one unit per heading, text before the first heading under the note title', () => {
    const md = [
      'Intro text.',
      '',
      '# Systole',
      'The heart contracts.',
      '```',
      '# not a heading',
      '```',
      '## Diastole ##',
      'The heart relaxes.',
      '### Empty',
      '',
    ].join('\r\n')
    const units = noteUnits('Heart', md)
    expect(units.map((u) => [u.index, u.kind, u.label, u.title])).toEqual([
      [1, 'section', '1', 'Heart'],
      [2, 'section', '2', 'Systole'],
      [3, 'section', '3', 'Diastole'],
    ])
    expect(units[1]?.text).toContain('# not a heading')
    expect(noteUnits('Empty', '  \n')).toEqual([])
  })

  test('long sections are split at paragraph breaks, an endless paragraph by size', () => {
    const para = 'word '.repeat(400).trim()
    const long = Array.from({ length: 8 }, () => para).join('\n\n')
    const units = noteUnits('Long', long)
    expect(units.length).toBeGreaterThan(1)
    expect(units.every((u) => u.text.length <= NOTE_UNIT_CHARS && u.title === 'Long')).toBe(true)
    expect(units.map((u) => u.text).join('\n\n')).toBe(long)
    const wall = 'x'.repeat(NOTE_UNIT_CHARS * 2 + 10)
    expect(noteUnits('Wall', wall).map((u) => u.text.length)).toEqual([NOTE_UNIT_CHARS, NOTE_UNIT_CHARS, 10])
  })
})

describe('auto questions: planning a run', () => {
  test('destination, language and dedupe follow the settings', () => {
    const { ws, courseId, sectionId, sourceId } = setup()
    const card = ws.cards.create({ courseId, kind: 'basic' })
    ws.text({ id: card, field: 'front' }).insert(0, 'Existing question')
    ws.courses.update(courseId, { language: 'fr' })
    const plan = planRun(ws, sourceId, 'added') as RunPlan
    expect(plan.destination).toEqual({ courseId, sectionId })
    expect(plan.mode).toBe('propose')
    expect(plan.language).toBe('French')
    expect(plan.input).toMatchObject({
      sourceId,
      perUnit: 3,
      types: ['qa', 'cloze'],
      difficulty: 'mixed',
      courseTitle: 'Physiology',
      deckTitle: 'Heart',
      existing: ['Existing question'],
    })
    expect(existingCardTexts(ws, courseId)).toEqual(['Existing question'])

    const other = ws.courses.create({ title: 'Anatomy' })
    ws.drafts.settings.set({ destination: { courseId: other }, language: 'de', dedupe: false, mode: 'add' })
    const again = planRun(ws, sourceId, 'added') as RunPlan
    expect(again.destination).toEqual({ courseId: other })
    expect(again.language).toBe('German')
    expect(again.mode).toBe('add')
    expect(again.input.existing).toBeUndefined()
    expect(again.input.courseTitle).toBe('Anatomy')
    // A destination course in the trash: back to the source's own place.
    ws.courses.trash(other)
    expect(destinationOf(ws, ws.sources.get(sourceId) as never, ws.drafts.settings.get())).toEqual({
      courseId,
      sectionId,
    })
    ws.drafts.settings.set({ destination: { courseId, sectionId } })
    expect((planRun(ws, sourceId, 'added') as RunPlan).destination).toEqual({ courseId, sectionId })
    const root = ws.sources.create({ courseId, kind: 'note', title: 'Root' })
    ws.drafts.settings.set({ destination: undefined })
    expect((planRun(ws, root, 'added') as RunPlan).destination).toEqual({ courseId })
  })

  test("'off' only stops added sources; gone sources are reported", () => {
    const { ws, courseId, sectionId, sourceId } = setup()
    ws.drafts.settings.set({ mode: 'off' })
    expect(planRun(ws, sourceId, 'added')).toBe('off')
    expect(typeof planRun(ws, sourceId, 'manual')).toBe('object')
    expect((planRun(ws, sourceId, 'manual') as RunPlan).mode).toBe('propose')
    expect(planRun(ws, 'missing', 'manual')).toBe('source-gone')
    ws.sections.trash(sectionId)
    expect(planRun(ws, sourceId, 'manual')).toBe('source-gone')
    ws.sections.restore(sectionId)
    ws.courses.trash(courseId)
    expect(planRun(ws, sourceId, 'manual')).toBe('source-gone')
    ws.courses.restore(courseId)
    ws.sources.trash(sourceId)
    expect(planRun(ws, sourceId, 'manual')).toBe('source-gone')
  })

  test('the duplicate test follows rejections made while a run goes on', () => {
    const { ws, courseId, sourceId } = setup()
    const other = ws.sources.create({ courseId, kind: 'note', title: 'Other' })
    const isDuplicate = draftDuplicates(ws, sourceId)
    expect(isDuplicate({ front: 'What is systole?' })).toBe(false)
    const [own] = ws.drafts.propose([
      { sourceId, courseId, unit: 1, kind: 'basic', type: 'qa', front: 'What is systole?', back: 'b' },
      { sourceId: other, courseId, unit: 1, kind: 'basic', type: 'qa', front: 'What is diastole?', back: 'b' },
    ]) as [string]
    expect(isDuplicate({ front: 'what is SYSTOLE' })).toBe(true)
    // Proposed for another source: not this run's concern.
    expect(isDuplicate({ front: 'What is diastole?' })).toBe(false)
    ws.drafts.edit(own, { front: 'Define systole' })
    expect(isDuplicate({ front: 'Define systole' })).toBe(true)
    const [rejected] = ws.drafts.list({ sourceId: other })
    ws.drafts.reject(rejected?.id as string)
    expect(isDuplicate({ front: 'What is diastole?' })).toBe(true)
  })

  test('questions become drafts bound for the destination, with their unit labels', () => {
    const { ws, courseId, sectionId, sourceId } = setup()
    const plan = planRun(ws, sourceId, 'added') as RunPlan
    const units = [{ index: 2, kind: 'slide' as const, label: '2', title: 't', text: 'x' }]
    const drafts = toNewDrafts(
      [
        question('Q one', 2, { quote: 'x' }),
        question('  ', 2),
        question('no deletion', 2, { kind: 'cloze', type: 'cloze' }),
        question('The {{c1::heart}}', 9, { kind: 'cloze', type: 'cloze', back: '' }),
        question('odd unit', -3),
      ],
      plan,
      units,
      'mockai/mock-1',
    )
    expect(drafts).toEqual([
      {
        sourceId,
        courseId,
        sectionId,
        unit: 2,
        unitKind: 'slide',
        unitLabel: '2',
        kind: 'basic',
        type: 'qa',
        difficulty: 'easy',
        front: 'Q one',
        back: 'b',
        quote: 'x',
        model: 'mockai/mock-1',
      },
      {
        sourceId,
        courseId,
        sectionId,
        unit: 9,
        kind: 'cloze',
        type: 'cloze',
        difficulty: 'easy',
        front: 'The {{c1::heart}}',
        back: '',
        model: 'mockai/mock-1',
      },
      {
        sourceId,
        courseId,
        sectionId,
        unit: 0,
        kind: 'basic',
        type: 'qa',
        difficulty: 'easy',
        front: 'odd unit',
        back: 'b',
        model: 'mockai/mock-1',
      },
    ])
    expect(ws.drafts.propose(drafts)).toHaveLength(3)
    expect(toNewDrafts([question('x')], { source: plan.source, destination: { courseId } }, [])[0]).toEqual({
      sourceId,
      courseId,
      unit: 1,
      kind: 'basic',
      type: 'qa',
      difficulty: 'easy',
      front: 'x',
      back: 'b',
    })
  })
})
