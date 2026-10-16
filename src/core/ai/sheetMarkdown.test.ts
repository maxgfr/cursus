import { describe, expect, test } from 'bun:test'
import type { SourceRef } from './schemas'
import { citedSources, sheetMarkdown } from './sheetMarkdown'

const cite = (ref: Partial<SourceRef> | undefined) =>
  ref?.sourceId === 'pdf'
    ? { label: 'sample · Slide 2', href: `#/source/pdf?page=${ref.page ?? 1}` }
    : ref?.sourceId === 'note'
      ? { label: 'Notes [draft]', href: '#/source/note' }
      : null

describe('a study sheet as Markdown', () => {
  const sheet = {
    title: 'Photosynthesis',
    summary: 'How plants make sugar.',
    points: [
      { heading: 'Light', explanation: 'Chlorophyll captures light.', sourceRef: { sourceId: 'note' } },
      { heading: 'Calvin cycle', explanation: 'It fixes CO2.', sourceRef: { sourceId: 'pdf', page: 2 } },
      { heading: 'Made up', explanation: 'Cited nowhere known.', sourceRef: { sourceId: 'invented' } },
    ],
  }

  test('its summary, then each point under its heading closed by the link to what it cites', () => {
    expect(sheetMarkdown(sheet, cite, true)).toBe(
      [
        'How plants make sugar.',
        '## Light',
        'Chlorophyll captures light.',
        '*[Notes \\[draft\\]](#/source/note)*',
        '## Calvin cycle',
        'It fixes CO2.',
        '*[sample · Slide 2](#/source/pdf?page=2)*',
        '## Made up',
        'Cited nowhere known.',
      ].join('\n\n'),
    )
    expect(citedSources(sheet)).toEqual(['note', 'pdf', 'invented'])
  })

  test('while it is written, the last point waits for its link', () => {
    const partial = { summary: 'How plants', points: [{ heading: 'Light', sourceRef: { sourceId: 'note' } }] }
    expect(sheetMarkdown(partial, cite, false)).toBe('How plants\n\n## Light')
    expect(sheetMarkdown(partial, cite, true)).toBe('How plants\n\n## Light\n\n*[Notes \\[draft\\]](#/source/note)*')
    expect(sheetMarkdown({}, cite, false)).toBe('')
    expect(sheetMarkdown({ points: [undefined] }, cite, true)).toBe('')
  })
})
