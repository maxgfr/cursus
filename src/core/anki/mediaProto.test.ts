import { describe, expect, test } from 'bun:test'
import { ankiToMarkdown, mediaRefs } from './htmlToMd'
import { blobRefs, markdownToAnki } from './mdToAnki'
import { decodeMediaEntries, notetypeKind, ProtoError, readFields } from './mediaProto'

const H = 'a'.repeat(64)

describe('protobuf', () => {
  test('decodes MediaEntries', () => {
    const entry = [0x0a, 0x05, ...new TextEncoder().encode('a.png'), 0x10, 0x96, 0x01, 0x1a, 0x01, 0xff]
    const buf = new Uint8Array([0x0a, entry.length, ...entry])
    expect(decodeMediaEntries(buf)).toEqual([{ name: 'a.png', size: 150 }])
  })
  test('notetype kind', () => {
    expect(notetypeKind(new Uint8Array([0x08, 0x01]))).toBe('cloze')
    expect(notetypeKind(new Uint8Array([0x1a, 0x00]))).toBe('normal')
  })
  test('rejects truncated input', () => {
    expect(() => readFields(new Uint8Array([0x0a, 0x05, 0x01]))).toThrow(ProtoError)
    expect(() => readFields(new Uint8Array([0x08]))).toThrow(ProtoError)
  })
})

describe('html <-> markdown', () => {
  test('anki html to markdown', () => {
    const md = ankiToMarkdown('x \\(a &lt; b\\) \\[y\\] <img src="p&amp;q.png"> [sound:s.mp3] [sound:none.mp3]', (n) =>
      n === 'p&q.png' || n === 's.mp3' ? H : null,
    )
    expect(md).toBe(`x $a < b$ $$y$$ ![](cursus-blob:${H}) <audio controls src="cursus-blob:${H}"></audio>`)
    expect(mediaRefs("<img src='a.png'>[sound:b.mp3]")).toEqual(['a.png', 'b.mp3'])
  })
  test('markdown to anki html', () => {
    expect(markdownToAnki(`*x* $a<b$ ![](cursus-blob:${H})`, () => 'f.png')).toBe(
      '<em>x</em> \\(a&lt;b\\) <img src="f.png" alt="">',
    )
    expect(markdownToAnki(`<audio controls src="cursus-blob:${H}"></audio>`, () => null)).toBe('')
    expect(markdownToAnki('a\n\nb', () => null)).toBe('<p>a</p>\n<p>b</p>')
    expect(blobRefs(`cursus-blob:${H} cursus-blob:${H}`)).toEqual([H])
  })
})
