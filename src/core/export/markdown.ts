import type { ModelWorkspace } from '../model/workspace'

/** Relative path → file contents of the readable export. */
export type ExportFiles = Map<string, string>

const UNSAFE = /[\\/:*?"<>|]/g

function stripControl(s: string): string {
  return [...s].map((ch) => ((ch.codePointAt(0) ?? 0) < 0x20 ? ' ' : ch)).join('')
}

/** A file or folder name every filesystem and sync service accepts. */
export function safeName(title: string, fallback: string): string {
  const s = stripControl(title)
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return s.length > 0 ? s : fallback
}

/** Returns `name+ext`, or `name (2)ext`, `name (3)`… when already taken in `used`. */
function unique(used: Set<string>, name: string, ext = ''): string {
  let out = name + ext
  for (let i = 2; used.has(out.toLowerCase()); i++) out = `${name} (${i})${ext}`
  used.add(out.toLowerCase())
  return out
}

/** RFC 4180 field: quoted when it holds a separator, a quote or a line break. */
export function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function csvRow(fields: readonly string[]): string {
  return `${fields.map(csvField).join(',')}\r\n`
}

function textOf(w: ModelWorkspace, id: string, field: 'body' | 'front' | 'back'): string {
  return w.text({ id, field }).toString()
}

/**
 * Readable export of live (not trashed) content: `<Course>/<Source>.md`,
 * `<Course>/fiches/<Fiche>.md` and `<Course>/cards.csv` (front, back, tags).
 */
export function exportMarkdown(w: ModelWorkspace): ExportFiles {
  const files: ExportFiles = new Map()
  const courseNames = new Set<string>()
  for (const course of w.courses.list()) {
    const dir = unique(courseNames, safeName(course.title, 'Course'))
    const names = new Set<string>(['fiches', 'cards.csv'])
    for (const s of w.sources.list({ courseId: course.id })) {
      if (s.kind !== 'note') continue
      const name = unique(names, safeName(s.title, 'Source'), '.md')
      files.set(`${dir}/${name}`, `# ${s.title}\n\n${textOf(w, s.id, 'body')}\n`)
    }
    const ficheNames = new Set<string>()
    for (const f of w.fiches.list({ courseId: course.id })) {
      const name = unique(ficheNames, safeName(f.title, 'Fiche'), '.md')
      let md = `# ${f.title}\n\n`
      if (f.subject) md += `_${f.subject}_\n\n`
      const body = textOf(w, f.id, 'body')
      if (body) md += `${body}\n\n`
      if (f.keyPoints?.length) md += `## Key points\n\n${f.keyPoints.map((k) => `- ${k.text}`).join('\n')}\n\n`
      files.set(`${dir}/fiches/${name}`, `${md.trimEnd()}\n`)
    }
    const cards = w.cards.list({ courseId: course.id })
    if (cards.length > 0) {
      let csv = csvRow(['front', 'back', 'tags'])
      for (const c of cards)
        csv += csvRow([textOf(w, c.id, 'front'), textOf(w, c.id, 'back'), (c.tags ?? []).join(' ')])
      files.set(`${dir}/cards.csv`, csv)
    }
  }
  return files
}
