import { unzipSync, zipSync } from 'fflate'
import { z } from 'zod'
import type { Id } from '../contracts/workspace'
import type { CardOrigin } from '../model/schema'
import type { ModelWorkspace } from '../model/workspace'

export const COURSE_EXT = '.cursus-course'
const FORMAT = 'cursus-course/1'
const ENTRY = 'course.json'

/**
 * Package-local references (`s0`, `f0`…) replace ids: an import always mints fresh ones.
 * The schema is a whitelist: `z.object` strips unknown keys, so untrusted metadata
 * (`deletedAt`, `purgedAt`, ids…) never reaches the synced doc.
 */
const optStr = z.string().optional()
const PackageSchema = z.object({
  format: z.literal(FORMAT),
  course: z.object({ title: z.string(), color: optStr, emoji: optStr, language: optStr, examDate: optStr }),
  sources: z.array(
    z.object({ ref: z.string(), kind: z.enum(['note', 'pdf', 'image']), title: z.string(), body: z.string() }),
  ),
  fiches: z.array(
    z.object({
      ref: z.string(),
      title: z.string(),
      subject: optStr,
      template: optStr,
      sourceRefs: z.array(z.string()),
      keyPoints: z.array(
        z.object({
          text: z.string(),
          sourceRef: z.object({ sourceId: z.string(), page: z.number().optional(), quote: optStr }).optional(),
        }),
      ),
      body: z.string(),
    }),
  ),
  cards: z.array(
    z.object({
      kind: z.enum(['basic', 'cloze']),
      ficheRef: optStr,
      sourceRef: optStr,
      front: z.string(),
      back: z.string(),
      tags: z.array(z.string()).optional(),
      origin: z.enum(['manual', 'ai', 'anki', 'cloze'] satisfies readonly CardOrigin[]).optional(),
    }),
  ),
})

export type CoursePackage = z.infer<typeof PackageSchema>

export class CoursePackageError extends Error {
  constructor(m: string) {
    super(m)
    this.name = 'CoursePackageError'
  }
}

/** Shares one course's content (no reviews, no attachments' bytes) as a `.cursus-course` zip. */
export function exportCourse(w: ModelWorkspace, courseId: Id): Uint8Array {
  const c = w.courses.get(courseId)
  if (!c) throw new CoursePackageError(`No course ${courseId}`)
  const sourceRef = new Map<Id, string>()
  const ficheRef = new Map<Id, string>()
  const pkg: CoursePackage = {
    format: FORMAT,
    course: { title: c.title, color: c.color, emoji: c.emoji, language: c.language, examDate: c.examDate },
    sources: w.sources.list({ courseId }).map((s, i) => {
      sourceRef.set(s.id, `s${i}`)
      return { ref: `s${i}`, kind: s.kind, title: s.title, body: w.text({ id: s.id, field: 'body' }).toString() }
    }),
    fiches: [],
    cards: [],
  }
  const mapRef = (id: Id | undefined) => (id === undefined ? undefined : sourceRef.get(id))
  pkg.fiches = w.fiches.list({ courseId }).map((f, i) => {
    ficheRef.set(f.id, `f${i}`)
    return {
      ref: `f${i}`,
      title: f.title,
      subject: f.subject,
      template: f.template,
      sourceRefs: (f.sourceIds ?? []).flatMap((id) => mapRef(id) ?? []),
      keyPoints: (f.keyPoints ?? []).map((k) => {
        const ref = mapRef(k.sourceRef?.sourceId)
        return ref && k.sourceRef ? { text: k.text, sourceRef: { ...k.sourceRef, sourceId: ref } } : { text: k.text }
      }),
      body: w.text({ id: f.id, field: 'body' }).toString(),
    }
  })
  pkg.cards = w.cards.list({ courseId }).map((k) => ({
    kind: k.kind,
    ficheRef: k.ficheId === undefined ? undefined : ficheRef.get(k.ficheId),
    sourceRef: mapRef(k.sourceId),
    front: w.text({ id: k.id, field: 'front' }).toString(),
    back: w.text({ id: k.id, field: 'back' }).toString(),
    tags: k.tags,
    origin: k.origin,
  }))
  return zipSync({ [ENTRY]: new TextEncoder().encode(JSON.stringify(pkg)) }, { mtime: new Date(Date.UTC(2000, 0, 1)) })
}

export function readCoursePackage(bytes: Uint8Array): CoursePackage {
  let json: unknown
  try {
    const entry = unzipSync(bytes)[ENTRY]
    if (!entry) throw new Error(`missing ${ENTRY}`)
    json = JSON.parse(new TextDecoder().decode(entry))
  } catch (err) {
    throw new CoursePackageError(`Not a ${COURSE_EXT} file: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = PackageSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new CoursePackageError(
      `Unsupported ${COURSE_EXT} format${issue ? ` at ${issue.path.join('.') || '(root)'}: ${issue.message}` : ''}`,
    )
  }
  return parsed.data
}

/** Imports a package as a NEW course: every entity gets a fresh id, nothing existing is touched. */
export function importCourse(w: ModelWorkspace, bytes: Uint8Array): Id {
  const pkg = readCoursePackage(bytes)
  return w.batch(() => {
    const courseId = w.courses.create({
      title: pkg.course.title,
      color: pkg.course.color,
      emoji: pkg.course.emoji,
      language: pkg.course.language,
      examDate: pkg.course.examDate,
    })
    const sources = new Map<string, Id>()
    const fiches = new Map<string, Id>()
    for (const s of pkg.sources) {
      const id = w.sources.create({ courseId, kind: s.kind, title: s.title })
      sources.set(s.ref, id)
      if (s.body) w.text({ id, field: 'body' }).insert(0, s.body)
    }
    for (const f of pkg.fiches) {
      const id = w.fiches.create({
        courseId,
        title: f.title,
        subject: f.subject,
        template: f.template,
        sourceIds: f.sourceRefs.flatMap((r) => sources.get(r) ?? []),
        keyPoints: f.keyPoints.map((k) => {
          const sid = k.sourceRef && sources.get(k.sourceRef.sourceId)
          return sid && k.sourceRef ? { text: k.text, sourceRef: { ...k.sourceRef, sourceId: sid } } : { text: k.text }
        }),
      })
      fiches.set(f.ref, id)
      if (f.body) w.text({ id, field: 'body' }).insert(0, f.body)
    }
    for (const c of pkg.cards) {
      const id = w.cards.create({
        courseId,
        kind: c.kind,
        ficheId: c.ficheRef === undefined ? undefined : fiches.get(c.ficheRef),
        sourceId: c.sourceRef === undefined ? undefined : sources.get(c.sourceRef),
        tags: c.tags,
        origin: c.origin,
      })
      if (c.front) w.text({ id, field: 'front' }).insert(0, c.front)
      if (c.back) w.text({ id, field: 'back' }).insert(0, c.back)
    }
    return courseId
  })
}
