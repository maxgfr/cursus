import { describe, expect, test } from 'bun:test'
import { Marked } from 'marked'
import { ankiToMarkdown } from '../anki/htmlToMd'
import { IMPORTANT_COLOR, markdownToAnki } from '../anki/mdToAnki'
import { highlightExtension, matchHighlight } from './highlight'

const marked = new Marked({ gfm: true, async: false }).use({
  extensions: [highlightExtension('highlight', '<mark>'), highlightExtension('important', '<mark class="important">')],
})
const inline = (md: string) => marked.parseInline(md, { async: false })

describe('highlights', () => {
  test('`==…==` highlights, `!!…!!` marks as important, Markdown inside', () => {
    expect(inline('a ==key idea== b')).toBe('a <mark>key idea</mark> b')
    expect(inline('a !!must know!! b')).toBe('a <mark class="important">must know</mark> b')
    expect(inline('==**bold** and *it*==')).toBe('<mark><strong>bold</strong> and <em>it</em></mark>')
    expect(inline('**==both==**')).toBe('<strong><mark>both</mark></strong>')
    expect(inline('==x== then !!y!!')).toBe('<mark>x</mark> then <mark class="important">y</mark>')
  })

  test('comparisons, exclamations and markers left open stay text', () => {
    for (const text of ['a == b', 'a === b', 'Wow!! Great!!', 'Hello!!!', '== x ==', '==x', '!!a\nb!!', '====']) {
      expect(inline(text)).not.toContain('<mark')
    }
    expect(inline('Look: ![a](b.png)')).toContain('<img')
  })

  test('matchHighlight reads one line, the text not starting or ending with a space', () => {
    expect(matchHighlight('highlight', '==a== rest')).toEqual({ raw: '==a==', text: 'a' })
    expect(matchHighlight('highlight', '==a = b== rest')).toEqual({ raw: '==a = b==', text: 'a = b' })
    expect(matchHighlight('important', '!!a\\!!b!!')).toEqual({ raw: '!!a\\!!b!!', text: 'a\\!!b' })
    expect(matchHighlight('highlight', '==a===')).toBeNull()
    expect(matchHighlight('important', '==a==')).toBeNull()
  })

  test('Anki export keeps them, important in its colour, and import brings them back', () => {
    const html = markdownToAnki('==a== and !!b!!', () => null)
    expect(html).toBe(
      `<mark>a</mark> and <mark class="important" style="background-color: ${IMPORTANT_COLOR}">b</mark>`,
    )
    expect(ankiToMarkdown(html, () => null)).toBe('==a== and !!b!!')
    expect(ankiToMarkdown('<mark> a </mark>', () => null)).toBe('==a==')
    expect(ankiToMarkdown('<mark class="cloze">a</mark>', () => null)).toBe('a')
  })
})
