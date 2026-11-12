import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** How long a finger (or a button) rests on a row before the row lifts. */
const LONG_PRESS_MS = 450
/** Moving further than this before then is a scroll or a swipe: the row never lifts. */
const SLOP_PX = 8
/** Near the top or bottom edge of the scrolling area, a lifted row scrolls the list. */
const EDGE_PX = 56
const MAX_SCROLL_PX = 14

export interface SortableOptions {
  /** The rows, in the order shown. */
  ids: readonly string[]
  /** One drop: the row goes just before `beforeId`, or last with null; `position` is 0-based, among `ids`. */
  onMove: (id: string, beforeId: string | null, position: number) => void
}

export interface SortableRowProps {
  ref: (el: HTMLLIElement | null) => void
  onPointerDown: (e: React.PointerEvent<HTMLLIElement>) => void
  onClickCapture: (e: React.MouseEvent<HTMLLIElement>) => void
  onContextMenu: (e: React.MouseEvent<HTMLLIElement>) => void
  onDragStart: (e: React.DragEvent<HTMLLIElement>) => void
  'data-sortable': true
  'data-lifted'?: true
}

export interface Sortable {
  /** Spread on the row's `<li>`: a long press lifts it. */
  row(id: string): SortableRowProps
  /** Spread on a grip inside the row: pressing it lifts the row at once. */
  handle(id: string): { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void }
  /** The row being dragged, if any. */
  lifted: string | null
}

interface Drag {
  id: string
  from: number
  pointerId: number
  /** Pointer Y when lifted, and the scroll offset then. */
  y0: number
  scroll0: number
  y: number
  scroller: Element
  /** Each row's element, top and height at lift time (in the scroller's content coordinates). */
  rows: { id: string; el: HTMLElement; top: number; height: number }[]
  to: number
  frame: number
}

interface Press {
  id: string
  pointerId: number
  x: number
  y: number
  timer: number
}

function scrollerOf(el: Element): Element {
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return document.scrollingElement ?? document.documentElement
}

/** The visible band of the scroller, in viewport coordinates. */
function bandOf(scroller: Element): { top: number; bottom: number } {
  if (scroller === document.scrollingElement || scroller === document.documentElement)
    return { top: 0, bottom: window.innerHeight }
  const r = scroller.getBoundingClientRect()
  return { top: Math.max(0, r.top), bottom: Math.min(window.innerHeight, r.bottom) }
}

/**
 * Reorders a list by dragging, with no library: a long press of a finger or a pen on a row lifts it (a tap still
 * opens it, a swipe still scrolls; a mouse keeps its clicks, menus and link drags), a grip lifts it at once. The lifted row follows the pointer, the others make room, and the list scrolls
 * near the edges; one write when it is dropped, none when Escape or the browser cancels the gesture.
 */
export function useSortable({ ids, onMove }: SortableOptions): Sortable {
  const els = useRef(new Map<string, HTMLLIElement>())
  const refs = useRef(new Map<string, (el: HTMLLIElement | null) => void>())
  const drag = useRef<Drag | null>(null)
  const press = useRef<Press | null>(null)
  // The click that follows a drop must not open the row it ends on.
  const swallowClick = useRef(false)
  const [lifted, setLifted] = useState<string | null>(null)
  const latest = useRef({ ids, onMove })
  latest.current = { ids, onMove }

  const layout = useCallback((d: Drag) => {
    const offset = d.scroller.scrollTop - d.scroll0
    const dy = d.y - d.y0 + offset
    const self = d.rows[d.from]
    if (self === undefined) return
    const center = self.top + self.height / 2 + dy
    let to = 0
    d.rows.forEach((r, i) => {
      if (i !== d.from && r.top + r.height / 2 < center) to++
    })
    d.to = to
    d.rows.forEach((r, i) => {
      if (i === d.from) r.el.style.transform = `translateY(${dy}px)`
      else if (i > d.from && i <= to) r.el.style.transform = `translateY(${-self.height}px)`
      else if (i < d.from && i >= to) r.el.style.transform = `translateY(${self.height}px)`
      else r.el.style.transform = ''
    })
  }, [])

  const cancelPress = useCallback(() => {
    const p = press.current
    if (p !== null) window.clearTimeout(p.timer)
    press.current = null
  }, [])

  const finish = useCallback((commit: boolean) => {
    const d = drag.current
    if (d === null) return
    drag.current = null
    cancelAnimationFrame(d.frame)
    for (const r of d.rows) {
      r.el.style.transform = ''
      delete r.el.dataset.sorting
    }
    setLifted(null)
    if (commit) {
      swallowClick.current = true
      window.setTimeout(() => {
        swallowClick.current = false
      }, 400)
    }
    if (commit && d.to !== d.from) {
      const others = d.rows.filter((_, i) => i !== d.from)
      latest.current.onMove(d.id, others[d.to]?.id ?? null, d.to)
    }
  }, [])

  const lift = useCallback(
    (id: string, pointerId: number, y: number) => {
      const { ids: order } = latest.current
      const from = order.indexOf(id)
      const el = els.current.get(id)
      if (from < 0 || el === undefined || order.length < 2) return
      const scroller = scrollerOf(el)
      const base = scroller.getBoundingClientRect().top - scroller.scrollTop
      const rows = order.flatMap((rid) => {
        const e = els.current.get(rid)
        if (e === undefined) return []
        const r = e.getBoundingClientRect()
        return [{ id: rid, el: e, top: r.top - base, height: r.height }]
      })
      if (rows.length !== order.length) return
      for (const r of rows) r.el.dataset.sorting = ''
      const d: Drag = { id, from, pointerId, y0: y, scroll0: scroller.scrollTop, y, scroller, rows, to: from, frame: 0 }
      drag.current = d
      setLifted(id)
      // Near an edge, scroll a little each frame, faster the closer the pointer.
      const tick = () => {
        const cur = drag.current
        if (cur !== d) return
        const band = bandOf(d.scroller)
        const up = band.top + EDGE_PX - d.y
        const down = d.y - (band.bottom - EDGE_PX)
        const step = up > 0 ? -Math.min(up, EDGE_PX) : down > 0 ? Math.min(down, EDGE_PX) : 0
        if (step !== 0) {
          d.scroller.scrollTop += (step / EDGE_PX) * MAX_SCROLL_PX
          layout(d)
        }
        d.frame = requestAnimationFrame(tick)
      }
      d.frame = requestAnimationFrame(tick)
    },
    [layout],
  )

  // Window listeners: the pointer may leave the row, and the row may re-render while it is held.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current
      if (p !== null && e.pointerId === p.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP_PX)
        cancelPress()
      const d = drag.current
      if (d === null || e.pointerId !== d.pointerId) return
      d.y = e.clientY
      layout(d)
    }
    const up = (e: PointerEvent) => {
      if (press.current?.pointerId === e.pointerId) cancelPress()
      if (drag.current?.pointerId === e.pointerId) finish(e.type === 'pointerup')
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag.current !== null) {
        e.preventDefault()
        finish(false)
      }
    }
    // While a row is lifted, the finger drags it instead of scrolling the page (needs a non-passive listener).
    const touchMove = (e: TouchEvent) => {
      if (drag.current !== null && e.cancelable) e.preventDefault()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', key)
    window.addEventListener('touchmove', touchMove, { passive: false })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', key)
      window.removeEventListener('touchmove', touchMove)
      cancelPress()
      finish(false)
    }
  }, [layout, cancelPress, finish])

  const refFor = useCallback((id: string) => {
    let r = refs.current.get(id)
    if (r === undefined) {
      r = (el: HTMLLIElement | null) => {
        if (el === null) els.current.delete(id)
        else els.current.set(id, el)
      }
      refs.current.set(id, r)
    }
    return r
  }, [])

  return useMemo<Sortable>(
    () => ({
      lifted,
      row: (id) => ({
        ref: refFor(id),
        'data-sortable': true,
        ...(lifted === id ? { 'data-lifted': true as const } : {}),
        onPointerDown: (e) => {
          if (drag.current !== null || press.current !== null) return
          if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
          swallowClick.current = false
          const { pointerId, clientX: x, clientY: y } = e
          const timer = window.setTimeout(() => {
            press.current = null
            lift(id, pointerId, y)
          }, LONG_PRESS_MS)
          press.current = { id, pointerId, x, y, timer }
        },
        onClickCapture: (e) => {
          if (!swallowClick.current) return
          swallowClick.current = false
          e.preventDefault()
          e.stopPropagation()
        },
        // A long press must not open the browser's menu or start a native link drag.
        onContextMenu: (e) => {
          if (press.current !== null || drag.current !== null) e.preventDefault()
        },
        onDragStart: (e) => {
          if (press.current !== null || drag.current !== null) e.preventDefault()
        },
      }),
      handle: (id) => ({
        onPointerDown: (e) => {
          if (drag.current !== null) return
          if (e.pointerType === 'mouse' && e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          cancelPress()
          lift(id, e.pointerId, e.clientY)
        },
      }),
    }),
    [lifted, refFor, lift, cancelPress],
  )
}
