import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react'
import { useT } from '../../i18n/react.tsx'
import styles from './ChatPanel.module.css'
import { clampWidth, currentBounds, DEFAULT_REM, STEP_PX, setChatWidth, useChatWidth } from './chatWidth.ts'

/** The width the chat shows now, in px (the chosen one inside the window, else the default). */
function shownWidth(chosen: number | null): number {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  return clampWidth(chosen ?? DEFAULT_REM * rem, currentBounds())
}

/**
 * The chat's left edge, to make it wider or narrower: dragged, or with ← and → (Home and End for its narrowest and
 * widest), a double click going back to the default width. Remembered on this device.
 */
export function ResizeHandle() {
  const t = useT()
  const chosen = useChatWidth()
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const now = shownWidth(chosen)
  const bounds = currentBounds()
  const set = (px: number) => setChatWidth(clampWidth(px, currentBounds()))

  const down = (e: PointerEvent<HTMLHRElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, width: now }
    setDragging(true)
  }
  const move = (e: PointerEvent<HTMLHRElement>) => {
    const d = drag.current
    // The edge is on the left: moving it left makes the chat wider.
    if (d) set(d.width + d.x - e.clientX)
  }
  const up = (e: PointerEvent<HTMLHRElement>) => {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const key = (e: KeyboardEvent<HTMLHRElement>) => {
    const next =
      e.key === 'ArrowLeft'
        ? now + STEP_PX
        : e.key === 'ArrowRight'
          ? now - STEP_PX
          : e.key === 'Home'
            ? bounds.min
            : e.key === 'End'
              ? bounds.max
              : null
    if (next === null) return
    e.preventDefault()
    set(next)
  }

  return (
    // A window splitter (WAI-ARIA): focusable, moved with the arrows, its position in px.
    <hr
      className={styles.resize}
      aria-orientation="vertical"
      aria-label={t('chat.resize')}
      aria-valuemin={Math.round(bounds.min)}
      aria-valuemax={Math.round(bounds.max)}
      aria-valuenow={now}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={() => setChatWidth(null)}
    />
  )
}
