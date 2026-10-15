/**
 * iCalendar (RFC 5545) export: a daily study reminder, one all-day event per exam, and one weekly recurring event
 * per planned session.
 */

export interface IcsExam {
  /** Stable id (the course id): the same exam keeps the same UID across exports. */
  id: string
  title: string
  /** `YYYY-MM-DD`. */
  date: string
}

/** A planned session: every week on these days at this local time. */
export interface IcsPlan {
  /** Stable id (the plan id): the same plan keeps the same UID across exports. */
  id: string
  summary: string
  description?: string
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  weekdays: readonly number[]
  /** Local wall-clock time, `HH:MM`. */
  time: string
  /** Default 20 minutes. */
  durationMinutes?: number
  /** Minutes before the start for its alarm; default 0 (at the start). */
  alarmMinutes?: number
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
  plans?: readonly IcsPlan[]
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
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
/** RFC 5545 BYDAY codes by ISO weekday. */
const BYDAY = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

const nonNegativeInt = (n: number): boolean => Number.isInteger(n) && n >= 0

/** Lines of one planned session: DTSTART on its first day on or after today, so it matches the rule. */
function planEvent(p: IcsPlan, now: number, stamp: string): string[] {
  const time = TIME.exec(p.time)
  if (!time) throw new RangeError(`Invalid plan time ${p.time}`)
  const days = [...new Set(p.weekdays)].sort((a, b) => a - b)
  if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    throw new RangeError(`Invalid plan weekdays ${p.weekdays.join(',')}`)
  const duration = p.durationMinutes ?? 20
  const alarm = p.alarmMinutes ?? 0
  if (!nonNegativeInt(duration) || duration === 0 || !nonNegativeInt(alarm))
    throw new RangeError(`Invalid plan duration ${duration} or alarm ${alarm}`)
  const today = new Date(now)
  let first = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  while (!days.includes(((new Date(first).getUTCDay() + 6) % 7) + 1)) first += 86_400_000
  const lines = [
    'BEGIN:VEVENT',
    `UID:plan-${p.id}@cursus`,
    `DTSTAMP:${stamp}`,
    // Floating local time: the session follows the user's timezone.
    `DTSTART:${localDate(first)}T${time[1]}${time[2]}00`,
    `DURATION:PT${duration}M`,
    `RRULE:FREQ=WEEKLY;BYDAY=${days.map((d) => BYDAY[d]).join(',')}`,
    `SUMMARY:${escapeText(p.summary)}`,
  ]
  if (p.description) lines.push(`DESCRIPTION:${escapeText(p.description)}`)
  lines.push(
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(p.summary)}`,
    alarm === 0 ? 'TRIGGER:PT0M' : `TRIGGER:-PT${alarm}M`,
    'END:VALARM',
    'END:VEVENT',
  )
  return lines
}

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
  for (const p of o.plans ?? []) lines.push(...planEvent(p, o.now, stamp))
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join(CRLF) + CRLF
}
