/** A vertical span on screen, in viewport pixels. */
export interface Span {
  top: number
  bottom: number
}

/**
 * How far to scroll so the caret sits inside the part of the screen the keyboard leaves free: positive scrolls
 * down (the caret is under the keyboard), negative scrolls up (the caret is above the visible part), 0 leaves
 * the page as it is. A caret taller than the free part shows its top.
 */
export function revealDelta(caret: Span, free: Span): number {
  if (caret.bottom - caret.top > free.bottom - free.top) return caret.top - free.top
  if (caret.bottom > free.bottom) return caret.bottom - free.bottom
  if (caret.top < free.top) return caret.top - free.top
  return 0
}
