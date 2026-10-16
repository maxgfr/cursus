import { useSyncExternalStore } from 'react'

/**
 * The chat's width, set by dragging its edge (or with the keyboard), remembered on this device: a convenience, so
 * it falls back to the default whenever the browser keeps nothing. The shell turns it into `--chat-width`, which
 * the docked panel, the page beside it and the sheet on a tablet all read.
 */
export const CHAT_WIDTH_KEY = 'cursus:chat:width'
export const DEFAULT_REM = 24
export const MIN_REM = 20
/** What the page keeps beside a docked chat (the sidebar aside). */
export const PAGE_MIN_REM = 28
/** One arrow key's step. */
export const STEP_PX = 16

/** The width allowed in a window `viewport` px wide, with `beside` px of sidebar: never under the minimum. */
export function widthBounds(viewport: number, beside: number, rem: number): { min: number; max: number } {
  const min = MIN_REM * rem
  return { min, max: Math.max(min, viewport - beside - PAGE_MIN_REM * rem) }
}

export function clampWidth(px: number, bounds: { min: number; max: number }): number {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, px)))
}

/** From this width the chat docks beside the page (`ChatPanel`'s DOCKED); below, it is a sheet over it. */
export const DOCKED_PX = 1000

/**
 * The bounds in this window: docked, the page (and the sidebar, `[data-tabbar]`) keep their room; as a sheet over
 * the page (a tablet), only the window's edge counts.
 */
export function currentBounds(): { min: number; max: number } {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  if (innerWidth < DOCKED_PX) {
    const min = MIN_REM * rem
    return { min, max: Math.max(min, innerWidth - 2 * rem) }
  }
  const sidebar = document.querySelector('[data-tabbar]')?.getBoundingClientRect().width ?? 0
  return widthBounds(innerWidth, sidebar, rem)
}

function read(): number | null {
  try {
    const v = Number(localStorage.getItem(CHAT_WIDTH_KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

let width: number | null | undefined
const listeners = new Set<() => void>()

/** The width chosen on this device, in px; null for the default. */
export function chatWidth(): number | null {
  if (width === undefined) width = read()
  return width
}

/** Sets the width (null: back to the default) and remembers it on this device. */
export function setChatWidth(px: number | null): void {
  width = px
  try {
    if (px === null) localStorage.removeItem(CHAT_WIDTH_KEY)
    else localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(px)))
  } catch {
    // Storage refused (private mode): the width holds for this page only.
  }
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useChatWidth(): number | null {
  return useSyncExternalStore(subscribe, chatWidth, () => null)
}
