import { localOffset, studyDay } from '../../core/srs/fsrs'

/**
 * Whole study days from today to an ISO `YYYY-MM-DD` exam date; null when unset or malformed. A study day starts at
 * 04:00, as everywhere else (Today's lead, the stats' exam plans): at 01:30 it is still yesterday.
 */
export function daysUntil(examDate: string | undefined, now: number = Date.now()): number | null {
  if (examDate === undefined) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(examDate)
  if (!m) return null
  // Local noon of the exam day lies inside that study day whatever the zone.
  const exam = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime()
  return studyDay(exam, localOffset(exam)) - studyDay(now, localOffset(now))
}

/** Local `YYYY-MM-DD` of a time, for `<input type="date">` minimums. */
export function isoDay(now: number = Date.now()): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
