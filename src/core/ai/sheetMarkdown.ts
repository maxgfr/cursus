import type { DeepPartial } from 'ai'
import type { SourceRef, Understanding } from './schemas'

/** How a study sheet cites a source: the words of its link, and where it leads (`#/source/ID?page=N`, a photo…). */
export interface SheetCite {
  label: string
  href: string
}

/** A link's words as Markdown reads them: brackets escaped. */
const linkText = (label: string) => label.replace(/[[\]\\]/g, (c) => `\\${c}`)

/**
 * A study sheet as the Markdown of its body: its summary, then each point under its heading, closed by a link to the
 * passage it cites (`cite`: null when it cites nothing that can be opened). While it is written (`final` false) a
 * point's link waits until the next point starts: its citation may still be coming.
 */
export function sheetMarkdown(
  sheet: DeepPartial<Understanding>,
  cite: (ref: Partial<SourceRef> | undefined) => SheetCite | null,
  final: boolean,
): string {
  const parts: string[] = []
  const summary = sheet.summary?.trim() ?? ''
  if (summary !== '') parts.push(summary)
  const points = sheet.points ?? []
  points.forEach((p, i) => {
    const heading = p?.heading?.trim() ?? ''
    const explanation = p?.explanation?.trim() ?? ''
    if (heading !== '') parts.push(`## ${heading}`)
    if (explanation !== '') parts.push(explanation)
    const done = final || i < points.length - 1
    const link = done ? cite(p?.sourceRef) : null
    if (link) parts.push(`*[${linkText(link.label)}](${link.href})*`)
  })
  // Written as it comes, the last part is the one being written: the writer holds its unfinished line back.
  return parts.join('\n\n')
}

/** The sources a written sheet cites, each once, in order. */
export function citedSources(sheet: Understanding): string[] {
  return [...new Set(sheet.points.flatMap((p) => (p.sourceRef ? [p.sourceRef.sourceId] : [])))]
}
