import { useEffect, useState } from 'react'
import { useRuntime } from '../../../app/workspaceContext.tsx'
import type { SourceRecord } from '../../../core/model/schema'
import type { Translate } from '../../../i18n/index.ts'
import { useT } from '../../../i18n/react.tsx'
import { noteError } from '../../settings/Diagnostic/recent.ts'

/**
 * « Slide 12 », « Page 7 », « Section 2.3 »: the unit of a slide deck or document a citation points at
 * (`page` is its number), read through the import's deck cache. Null for other sources, or until read.
 */
export function useCitedUnit(source: SourceRecord | undefined, page: number | undefined): string | null {
  const t = useT()
  const rt = useRuntime()
  const [named, setNamed] = useState<{ key: string; name: string } | null>(null)
  const id = source?.id
  const blobId = source?.blobId
  const title = source?.title ?? ''
  const deck = source?.support !== undefined
  const key = deck && id !== undefined && page !== undefined ? `${id}/${blobId ?? ''}/${page}` : ''
  useEffect(() => {
    if (key === '') return
    let live = true
    import('../../DeckImport/deckSource.ts')
      .then(async ({ loadDeck, unitName }) => {
        const unit = (await loadDeck(rt, { blobId, title })).deck.units.find((u) => u.index === page)
        if (live && unit) setNamed({ key, name: unitName(t, unit) })
      })
      // The citation keeps its link; only the unit's name is missing (a file sync has not brought yet).
      .catch((e: unknown) => noteError('deck.cite', e))
    return () => {
      live = false
    }
  }, [key, rt, blobId, title, page, t])
  return named !== null && named.key === key ? named.name : null
}

/** How a citation reads: « Notes », « Notes, p. 2 », « Slides · Slide 2 » (a deck's unit, once named). */
export function citationText(
  t: Translate,
  name: string,
  source: SourceRecord | undefined,
  page: number | undefined,
  unit: string | null,
): string {
  if (unit !== null) return `${name} · ${unit}`
  if (page === undefined || source?.support !== undefined) return name
  return t('ai.citePage', { source: name, page })
}
