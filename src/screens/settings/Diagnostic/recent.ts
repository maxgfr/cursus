/** Technical detail of failures the UI explained in plain words, kept in memory for the diagnostic report only. */
const MAX = 50
const entries: string[] = []

/** Records a failure's technical detail; the screen shows its own plain explanation. */
export function noteError(where: string, e: unknown): void {
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  entries.push(`${new Date().toISOString()} ${where} ${detail}`)
  if (entries.length > MAX) entries.splice(0, entries.length - MAX)
}

/** Recorded failures, oldest first. */
export function recentErrors(): readonly string[] {
  return [...entries]
}
