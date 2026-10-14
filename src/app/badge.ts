import { useEffect } from 'react'

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

/** Shows the due count on the installed app icon where the Badging API exists; clears it at zero. */
export function setDueBadge(due: number): void {
  const nav = navigator as BadgeNavigator
  if (typeof nav.setAppBadge !== 'function') return
  const done = due > 0 ? nav.setAppBadge(due) : (nav.clearAppBadge?.() ?? nav.setAppBadge(0))
  done.catch((e: unknown) => {
    // Not installed or not allowed: the badge is a nicety, the Today screen still shows the count.
    console.warn('app badge unavailable', e)
  })
}

export function useDueBadge(due: number): void {
  useEffect(() => setDueBadge(due), [due])
}
