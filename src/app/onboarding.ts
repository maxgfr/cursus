/**
 * Whether this device has seen the welcome screen. A first launch on an empty library opens it once; after
 * that an empty library shows Today's own empty state. A plain device flag (`localStorage`): losing it only
 * shows the welcome again on an empty library, so it needs neither the workspace nor the device store.
 */
export const ONBOARDED_KEY = 'cursus:onboarded'

export function onboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1'
  } catch {
    // Storage blocked (private mode, policy): never send the student in circles.
    return true
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, '1')
  } catch (e) {
    console.warn('onboarding flag not kept', e)
  }
}
