const DAY = 86_400_000

/** Whole local days from today to an ISO `YYYY-MM-DD` exam date; null when unset or malformed. */
export function daysUntil(examDate: string | undefined, now: number = Date.now()): number | null {
  if (examDate === undefined) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(examDate)
  if (!m) return null
  const exam = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(now)
  const today = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((exam - today) / DAY)
}

/** Local `YYYY-MM-DD` of a time, for `<input type="date">` minimums. */
export function isoDay(now: number = Date.now()): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
