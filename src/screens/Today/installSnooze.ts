/** A dismissed hint comes back after this long, until the app runs installed or has a backup. */
export const INSTALL_HINT_SNOOZE_MS = 7 * 86_400_000

/**
 * Whether a dismissal stored in kv still holds at `now`. It stores the time of dismissal; the flag
 * older versions stored (`true`) has no date, so the hint comes back once.
 */
export function stillDismissed(stored: unknown, now: number): boolean {
  return typeof stored === 'number' && now - stored < INSTALL_HINT_SNOOZE_MS
}
