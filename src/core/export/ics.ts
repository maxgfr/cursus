/** iCalendar (RFC 5545) export: a daily study reminder and one all-day event per exam. */

export interface IcsExam {
  /** Stable id (the course id): the same exam keeps the same UID across exports. */
  id: string
  title: string
  /** `YYYY-MM-DD`. */
  date: string
}

export interface IcsOptions {
  /** Export time, ms since epoch (DTSTAMP). */
  now: number
  /** Local wall-clock time of the daily reminder; omitted = no reminder. */
  daily?: { hour: number; minute: number; summary: string; description?: string }
  exams?: readonly IcsExam[]
  /** Summary prefix of exam events, already localised (e.g. "Exam: "). */
  examPrefix?: string
  /** Minutes before the exam day starts for its alarm; default one day. */
  examAlarmMinutes?: number
}

const CRLF = '\r\n'
const enc = new TextEncoder()

/** TEXT value escaping (RFC 5545 §3.3.11). */
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** Folds a content line at 75 octets without splitting a UTF-8 sequence (RFC 5545 §3.1). */
export function foldLine(line: string): string {
  const parts: string[] = []
  let cur = ''
  let size = 0
  let limit = 75
  for (const ch of line) {
    const n = enc.encode(ch).length
    if (size + n > limit) {
      parts.push(cur)
      cur = ''
      size = 0
      limit = 74 // continuation lines start with a space
    }
    cur += ch
    size += n
  }
  parts.push(cur)
  return parts.join(`${CRLF} `)
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function utcStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
}

function dayAfter(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return localDate(Date.UTC(y as number, (m as number) - 1, (d as number) + 1))
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function buildIcs(o: IcsOptions): string {
  const stamp = utcStamp(o.now)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Cursus//Cursus//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ]
  if (o.daily) {
    const { hour, minute } = o.daily
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59)
      throw new RangeError(`Invalid reminder time ${hour}:${minute}`)
    // Floating local time: the reminder follows the user's timezone.
    lines.push(
      'BEGIN:VEVENT',
      'UID:daily-review@cursus',
      `DTSTAMP:${stamp}`,
      `DTSTART:${localDate(o.now)}T${pad(hour)}${pad(minute)}00`,
      'DURATION:PT15M',
      'RRULE:FREQ=DAILY',
      `SUMMARY:${escapeText(o.daily.summary)}`,
    )
    if (o.daily.description) lines.push(`DESCRIPTION:${escapeText(o.daily.description)}`)
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(o.daily.summary)}`,
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
    )
  }
  for (const e of o.exams ?? []) {
    if (!DATE.test(e.date)) throw new RangeError(`Invalid exam date ${e.date}`)
    const summary = `${o.examPrefix ?? ''}${e.title}`
    lines.push(
      'BEGIN:VEVENT',
      `UID:exam-${e.id}@cursus`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${e.date.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${dayAfter(e.date)}`,
      `SUMMARY:${escapeText(summary)}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(summary)}`,
      `TRIGGER:-PT${o.examAlarmMinutes ?? 1440}M`,
      'END:VALARM',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join(CRLF) + CRLF
}
