import { useEffect } from 'react'
import { revealDelta, type Span } from './keyboardReveal.ts'

/** Room kept above the caret (a sticky header) and between it and the keyboard. */
const TOP_ROOM = 72
const BOTTOM_ROOM = 16
/** The keyboard has settled once the viewport stops resizing for this long. */
const SETTLE_MS = 120

const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]'

/** Where the caret is: the selection inside the focused field, else the field itself. */
function caretOf(el: HTMLElement): Span | null {
  const sel = document.getSelection()
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    const rects = sel.getRangeAt(0).getClientRects()
    const r = rects[rects.length - 1] ?? sel.getRangeAt(0).getBoundingClientRect()
    if (r.height > 0) return { top: r.top, bottom: r.bottom }
  }
  const r = el.getBoundingClientRect()
  return r.height > 0 ? { top: r.top, bottom: Math.min(r.bottom, r.top + 3 * 24) } : null
}

/** The element that scrolls `el` into view: its nearest scrolling ancestor, else the page. */
function scrollerOf(el: HTMLElement): Element {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return document.scrollingElement ?? document.documentElement
}

/**
 * Publishes the on-screen keyboard height as `--kb-inset` on <html> (iOS shrinks only the visual
 * viewport), how far iOS has moved the visible part of the page down as `--vv-top` (what is pinned to the
 * screen's top follows it, or leaves the screen), and `data-keyboard` while the keyboard is open so the tab bar
 * can step aside. Once the keyboard has settled, the caret is brought into the part of the screen it leaves
 * free: iOS scrolls while the keyboard is still rising, against the full height, and often leaves the caret
 * under it (on iPad above all).
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let settle: ReturnType<typeof setTimeout> | undefined
    let lastInset = 0

    const reveal = () => {
      const el = document.activeElement
      if (!(el instanceof HTMLElement) || !el.matches(EDITABLE) || !root.dataset.keyboard) return
      const caret = caretOf(el)
      if (!caret) return
      const free = { top: vv.offsetTop + TOP_ROOM, bottom: vv.offsetTop + vv.height - BOTTOM_ROOM }
      const delta = revealDelta(caret, free)
      if (delta !== 0) scrollerOf(el).scrollBy({ top: delta })
    }
    const later = () => {
      clearTimeout(settle)
      settle = setTimeout(reveal, SETTLE_MS)
    }

    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      root.style.setProperty('--kb-inset', `${inset}px`)
      root.style.setProperty('--vv-top', `${Math.max(0, Math.round(vv.offsetTop))}px`)
      if (inset > 80) root.dataset.keyboard = 'open'
      else delete root.dataset.keyboard
      // Only when the keyboard rose or grew: a scroll of the page itself must not pull the caret back.
      if (inset > lastInset + 40) later()
      lastInset = inset
    }
    // Moving to another field while the keyboard stays up: iOS does not always scroll to it.
    const onFocus = () => {
      if (root.dataset.keyboard) later()
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    document.addEventListener('focusin', onFocus)
    return () => {
      clearTimeout(settle)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.removeEventListener('focusin', onFocus)
    }
  }, [])
}
