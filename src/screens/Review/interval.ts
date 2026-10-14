const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Short, locale-aware interval ("10 min", "3 days", "2 mo"). */
export function formatInterval(ms: number, tag: string): string {
  const unit = (value: number, u: 'minute' | 'hour' | 'day' | 'month' | 'year') =>
    new Intl.NumberFormat(tag, { style: 'unit', unit: u, unitDisplay: 'short', maximumFractionDigits: 1 }).format(value)
  if (ms < HOUR) return unit(Math.max(1, Math.round(ms / MINUTE)), 'minute')
  if (ms < DAY) return unit(Math.round(ms / HOUR), 'hour')
  const days = Math.round(ms / DAY)
  if (days < 31) return unit(days, 'day')
  if (days < 365) return unit(Math.round(days / 30.4), 'month')
  return unit(Math.round((days / 365) * 10) / 10, 'year')
}
