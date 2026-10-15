import { useEffect, useState } from 'react'
import { openPdf } from '../../core/content/pdf'
import { noteError } from '../settings/Diagnostic/recent.ts'
import type { LoadedDeck } from './deckSource.ts'

export interface Thumb {
  url: string
  alt: string
}

/** Formats a browser shows in an `<img>` (EMF/WMF/TIFF pictures get no thumbnail). */
const SHOWN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'])
/** PDF pages rendered as thumbnails at most: a long document keeps its first pages illustrated. */
const MAX_PDF_THUMBS = 80
const THUMB_SIZE = 360

/**
 * A small picture per unit: its first image for a slide or a section, the rendered page for a PDF (pages
 * render one after the other, in the background). Object URLs are revoked when the deck changes or the screen
 * leaves.
 */
export function useUnitThumbs(loaded: LoadedDeck | null): ReadonlyMap<number, Thumb> {
  const [thumbs, setThumbs] = useState<ReadonlyMap<number, Thumb>>(new Map())
  useEffect(() => {
    setThumbs(new Map())
    if (loaded === null) return
    const { deck, bytes } = loaded
    const urls: string[] = []
    const make = (blob: Blob): string => {
      const url = URL.createObjectURL(blob)
      urls.push(url)
      return url
    }
    if (deck.format !== 'pdf') {
      const byImage = new Map<string, string>()
      const out = new Map<number, Thumb>()
      for (const unit of deck.units) {
        for (const ref of unit.images) {
          const img = deck.images.get(ref.id)
          if (!img || !SHOWN.has(img.mime)) continue
          let url = byImage.get(img.id)
          if (url === undefined) {
            url = make(new Blob([new Uint8Array(img.bytes)], { type: img.mime }))
            byImage.set(img.id, url)
          }
          out.set(unit.index, { url, alt: ref.alt ?? '' })
          break
        }
      }
      setThumbs(out)
      return () => {
        for (const u of urls) URL.revokeObjectURL(u)
      }
    }
    const abort = new AbortController()
    void (async () => {
      const pdf = await openPdf(bytes, { signal: abort.signal })
      try {
        for (const unit of deck.units.slice(0, MAX_PDF_THUMBS)) {
          if (unit.page === undefined) continue
          const blob = await pdf.render(unit.page, { maxDimension: THUMB_SIZE, mime: 'image/jpeg', quality: 0.7 })
          if (abort.signal.aborted) return
          const url = make(blob)
          setThumbs((prev) => new Map(prev).set(unit.index, { url, alt: '' }))
        }
      } finally {
        await pdf.close()
      }
    })().catch((e: unknown) => {
      // Thumbnails are decoration: the units read fine without them, the failure is kept for diagnostics.
      if (!abort.signal.aborted) noteError('deck.thumbnails', e)
    })
    return () => {
      abort.abort()
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [loaded])
  return thumbs
}
