import type { Id } from '../../core/contracts/workspace'
import { COURSE_EXT, exportCourse } from '../../core/export/coursePackage'
import { buildIcs } from '../../core/export/ics'
import type { ModelWorkspace } from '../../core/model/workspace'

/** Saves a file through a temporary link (works offline, no permissions). */
export function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'course'
}

/**
 * Shares one course as a `.cursus-course` file: the Web Share sheet where it accepts files,
 * otherwise a download. Resolves to 'shared', 'downloaded' or 'cancelled'.
 */
export async function shareCourse(ws: ModelWorkspace, courseId: Id): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const course = ws.courses.get(courseId)
  if (!course) throw new Error(`No course ${courseId}`)
  const bytes = new Uint8Array(exportCourse(ws, courseId))
  const name = `${safeName(course.title)}${COURSE_EXT}`
  const blob = new Blob([bytes], { type: 'application/zip' })
  const file = new File([blob], name, { type: 'application/zip' })
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: course.title })
      return 'shared'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      // Share sheet refused (e.g. no user activation left): fall back to a download.
      console.warn('share failed, downloading instead', e)
    }
  }
  download(name, blob)
  return 'downloaded'
}

/** Daily reminder at 18:00 plus one all-day event per course exam. */
export function downloadCalendar(
  ws: ModelWorkspace,
  labels: { daily: string; examPrefix: string },
  now = Date.now(),
): void {
  const exams = ws.courses.list().flatMap((c) => (c.examDate ? [{ id: c.id, title: c.title, date: c.examDate }] : []))
  const ics = buildIcs({
    now,
    daily: { hour: 18, minute: 0, summary: labels.daily },
    exams,
    examPrefix: labels.examPrefix,
  })
  download('cursus.ics', new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
}
