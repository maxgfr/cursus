import type { Id } from '../contracts/workspace'
import type { ModelWorkspace } from '../model/workspace'

/**
 * Parses delimited text (RFC 4180 quoting). The separator is the Anki `#separator:` header
 * when present, else tab, semicolon or comma, whichever the first data line holds.
 * Anki header lines (`#key:value`) are skipped.
 */
export function parseDelimited(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/, '')
  let sep: string | undefined
  let body = ''
  for (const line of lines.split(/(?<=\n)/)) {
    const m = /^#([\w ]+):(.*?)\r?\n?$/.exec(line)
    if (m && body === '') {
      if (m[1] === 'separator') sep = ANKI_SEPARATORS[m[2]?.toLowerCase() ?? ''] ?? m[2]
      continue
    }
    body += line
  }
  sep ??= detect(body)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === sep) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

const ANKI_SEPARATORS: Record<string, string> = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' }

function detect(body: string): string {
  const first = body.split('\n', 1)[0] ?? ''
  for (const s of ['\t', ';', ',']) if (first.includes(s)) return s
  return '\t'
}

/**
 * Imports Anki "Notes in plain text" or Quizlet exports as basic cards of `courseId`:
 * column 1 = front, 2 = back, 3 = space-separated tags. A `front,back` header row is skipped.
 */
export function importCards(w: ModelWorkspace, courseId: Id, text: string): { created: number; skipped: number } {
  const rows = parseDelimited(text)
  const head = rows[0]
  if (head && head[0]?.trim().toLowerCase() === 'front' && head[1]?.trim().toLowerCase() === 'back') rows.shift()
  let created = 0
  let skipped = 0
  w.batch(() => {
    for (const r of rows) {
      const front = (r[0] ?? '').trim()
      const back = (r[1] ?? '').trim()
      if (!front || !back) {
        skipped++
        continue
      }
      const tags = (r[2] ?? '').split(/\s+/).filter((t) => t.length > 0)
      const id = w.cards.create({ courseId, kind: 'basic', tags: tags.length ? tags : undefined, origin: 'manual' })
      w.text({ id, field: 'front' }).insert(0, front)
      w.text({ id, field: 'back' }).insert(0, back)
      created++
    }
  })
  return { created, skipped }
}
