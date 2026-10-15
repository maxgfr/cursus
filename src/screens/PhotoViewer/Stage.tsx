import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type Rotation, renderPhoto } from '../../core/content/photos'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { useObjectUrl, usePhotoFile } from '../Photos/files.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './PhotoViewer.module.css'

export const MIN_ZOOM = 1
export const MAX_ZOOM = 6

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100))

/** The file as shown: turned by its rotation (a recomputed rendition, the stored file stays as it is). */
function useShown(blob: Blob | null, rotation: Rotation): Blob | null {
  const [shown, setShown] = useState<{ blob: Blob; rotation: Rotation; out: Blob } | null>(null)
  useEffect(() => {
    if (blob === null || rotation === 0) return
    let live = true
    renderPhoto(blob, rotation).then(
      (out) => {
        if (live) setShown({ blob, rotation, out })
      },
      (e: unknown) => noteError('photos.rotate', e),
    )
    return () => {
      live = false
    }
  }, [blob, rotation])
  if (blob === null) return null
  if (rotation === 0) return blob
  return shown !== null && shown.blob === blob && shown.rotation === rotation ? shown.out : null
}

export interface StageProps {
  blobId: string
  rotation: Rotation
  label: string
  zoom: number
  onZoom: (z: number) => void
  /** Called once the file is here (to enable sharing). */
  onFile: (blob: Blob | null) => void
}

/**
 * The photo, fitted to the stage at zoom 1. Zoom with pinch, ⌘/Ctrl + wheel or trackpad pinch, double-click or
 * the toolbar; the stage scrolls (one finger, wheel, keyboard) to pan. Downloads the file first when it is
 * still on the destinations.
 */
export function Stage({ blobId, rotation, label, zoom, onZoom, onFile }: StageProps) {
  const t = useT()
  const { state, retry } = usePhotoFile(blobId)
  const blob = state.phase === 'ready' ? state.blob : null
  const shown = useShown(blob, rotation)
  const url = useObjectUrl(shown)
  const stage = useRef<HTMLElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; zoom: number } | null>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  useEffect(() => onFile(blob), [blob, onFile])

  useEffect(() => {
    const el = stage.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Zooming keeps the point at the centre of the stage where it was.
  const centre = useRef<{ x: number; y: number } | null>(null)
  const zoomTo = useCallback(
    (z: number) => {
      const el = stage.current
      if (el && el.scrollWidth > 0 && el.scrollHeight > 0) {
        centre.current = {
          x: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth,
          y: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight,
        }
      }
      onZoom(clampZoom(z))
    },
    [onZoom],
  )
  useLayoutEffect(() => {
    void zoom
    const el = stage.current
    const c = centre.current
    if (!el || !c) return
    el.scrollLeft = c.x * el.scrollWidth - el.clientWidth / 2
    el.scrollTop = c.y * el.scrollHeight - el.clientHeight / 2
    centre.current = null
  }, [zoom])

  // ⌘/Ctrl + wheel (and the Mac trackpad's pinch, which arrives as such) zooms instead of scrolling the page.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomTo(zoomRef.current * Math.exp(-e.deltaY / 200))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  // Two fingers pinch to zoom; a double-click or double tap toggles between fitted and 250 %. The toolbar and the
  // keys do the same for keyboard and VoiceOver users.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const points = pointers.current
    const distance = (): number => {
      const [a, b] = [...points.values()]
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
    }
    const down = (e: PointerEvent) => {
      points.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (points.size === 2) pinch.current = { dist: distance(), zoom: zoomRef.current }
    }
    const move = (e: PointerEvent) => {
      if (!points.has(e.pointerId)) return
      points.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const p = pinch.current
      if (p && points.size === 2 && p.dist > 0) zoomTo(p.zoom * (distance() / p.dist))
    }
    const up = (e: PointerEvent) => {
      points.delete(e.pointerId)
      if (points.size < 2) pinch.current = null
    }
    const toggle = () => zoomTo(zoomRef.current > 1 ? 1 : 2.5)
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('dblclick', toggle)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('dblclick', toggle)
    }
  }, [zoomTo])

  let size: { width: number; height: number } | undefined
  if (natural && box.w > 0 && box.h > 0) {
    const fit = Math.min(box.w / natural.w, box.h / natural.h, 1)
    size = { width: Math.round(natural.w * fit * zoom), height: Math.round(natural.h * fit * zoom) }
  }

  return (
    <section
      ref={stage}
      className={styles.stage}
      data-zoomed={zoom > 1 || undefined}
      // A named region, focusable once zoomed so the arrow keys and Page Up/Down pan the photo.
      aria-label={label}
      tabIndex={zoom > 1 ? 0 : -1}
    >
      <div className={styles.canvas}>
        {url !== null ? (
          <img
            className={styles.photo}
            src={url}
            alt={label}
            draggable={false}
            data-testid="viewer-photo"
            style={size}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
        ) : state.phase === 'missing' ? (
          <div className={styles.missing}>
            <p role="alert">{t('photos.unavailable')}</p>
            <Button onClick={retry}>{t('photos.retry')}</Button>
          </div>
        ) : (
          <p className={styles.loading} role="status">
            {state.phase === 'fetching' ? t('photos.downloading') : t('common.loading')}
          </p>
        )}
      </div>
    </section>
  )
}
