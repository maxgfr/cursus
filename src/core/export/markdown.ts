import type { Id } from '../contracts/workspace'
import type { ModelWorkspace } from '../model/workspace'

/** Relative path → file contents of the readable export. */
export type ExportFiles = Map<string, string>

const UNSAFE = /[\\/:*?"<>|]/g

/** Names Windows refuses whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

function stripControl(s: string): string {
  return [...s]
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0
      return c < 0x20 || c === 0x7f ? ' ' : ch
    })
    .join('')
}

/**
 * A file or folder name every filesystem and sync service accepts: no separators or reserved
 * characters, no leading dot, no trailing dot or blank, not a Windows device name, at most 120 characters.
 */
export function safeName(title: string, fallback: string): string {
  const s = [...stripControl(title).normalize('NFC').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()]
    .slice(0, 120)
    .join('')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (s.length === 0) return fallback
  return RESERVED.test(s) ? `_${s}` : s
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
 * Readable export of live (not trashed) content, one folder per course and one sub-folder per subset
 * (`<Course>/<Subset>/<Sub-subset>/…`). Each folder holds its own `<Source>.md`, `fiches/<Fiche>.md`
 * and `cards.csv` (front, back, tags); items of a subset are in its folder only, not its parents'.
 */
export function exportMarkdown(w: ModelWorkspace): ExportFiles {
  const files: ExportFiles = new Map()
  const courseNames = new Set<string>()
  const tree = w.sections.tree()
  for (const course of w.courses.list()) {
    const at = (item: { courseId: Id; sectionId?: Id }): Id | null => tree.sectionOf(item)
    const sources = w.sources.list({ courseId: course.id })
    const fiches = w.fiches.list({ courseId: course.id })
    const cards = w.cards.list({ courseId: course.id })
    const writeFolder = (dir: string, sectionId: Id | null): void => {
      const names = new Set<string>(['fiches', 'cards.csv'])
      for (const s of sources) {
        if (s.kind !== 'note' || at(s) !== sectionId) continue
        const name = unique(names, safeName(s.title, 'Source'), '.md')
        files.set(`${dir}/${name}`, `# ${s.title}\n\n${textOf(w, s.id, 'body')}\n`)
      }
      const ficheNames = new Set<string>()
      for (const f of fiches) {
        if (at(f) !== sectionId) continue
        const name = unique(ficheNames, safeName(f.title, 'Fiche'), '.md')
        let md = `# ${f.title}\n\n`
        if (f.subject) md += `_${f.subject}_\n\n`
        const body = textOf(w, f.id, 'body')
        if (body) md += `${body}\n\n`
        if (f.keyPoints?.length) md += `## Key points\n\n${f.keyPoints.map((k) => `- ${k.text}`).join('\n')}\n\n`
        files.set(`${dir}/fiches/${name}`, `${md.trimEnd()}\n`)
      }
      const here = cards.filter((c) => at(c) === sectionId)
      if (here.length > 0) {
        let csv = csvRow(['front', 'back', 'tags'])
        for (const c of here)
          csv += csvRow([textOf(w, c.id, 'front'), textOf(w, c.id, 'back'), (c.tags ?? []).join(' ')])
        files.set(`${dir}/cards.csv`, csv)
      }
      for (const sub of tree.children(course.id, sectionId)) {
        writeFolder(`${dir}/${unique(names, safeName(sub.name, 'Subset'))}`, sub.id)
      }
    }
    writeFolder(unique(courseNames, safeName(course.title, 'Course')), null)
  }
  return files
}
