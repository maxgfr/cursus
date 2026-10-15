import type { Id } from '../../core/contracts/workspace'
import { COURSE_EXT, exportCoursePackage, type FileLoader } from '../../core/export/coursePackage'
import { buildIcs } from '../../core/export/ics'
import type { ModelWorkspace } from '../../core/model/workspace'
import { icsPlans } from '../Sessions/calendar.ts'
import { download, safeName } from './download.ts'

/**
 * Shares one course as a `.cursus-course` file, with its photos and files (`load` reads them, fetching one kept on
 * demand): the Web Share sheet where it accepts files, otherwise a download. Resolves to 'shared', 'downloaded' or
 * 'cancelled'.
 */
export async function shareCourse(
  ws: ModelWorkspace,
  courseId: Id,
  load: FileLoader,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const course = ws.courses.get(courseId)
  if (!course) throw new Error(`No course ${courseId}`)
  const { bytes } = await exportCoursePackage(ws, courseId, load)
  const name = `${safeName(course.title, 'course')}${COURSE_EXT}`
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/zip' })
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

/** Daily reminder at 18:00, one all-day event per course exam and one weekly event per planned session. */
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
    plans: icsPlans(ws.plans.list()),
  })
  download('cursus.ics', new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
}
