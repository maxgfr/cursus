/** « Show Markdown » in the editor, remembered on this device (a convenience: it falls back to off). */
export const SHOW_MARKDOWN_KEY = 'cursus:editor:markdown'

export function readShowMarkdown(): boolean {
  try {
    return localStorage.getItem(SHOW_MARKDOWN_KEY) === '1'
  } catch {
    return false
  }
}

export function writeShowMarkdown(on: boolean): void {
  try {
    if (on) localStorage.setItem(SHOW_MARKDOWN_KEY, '1')
    else localStorage.removeItem(SHOW_MARKDOWN_KEY)
  } catch {
    // Storage refused (private mode): the switch holds for this page only.
  }
}
