import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { to } from '../../app/routes.ts'
import { useRuntime } from '../../app/workspaceContext.tsx'
import type { SourceRecord } from '../../core/model/schema'
import { useT } from '../../i18n/react.tsx'
import { useAiReady } from '../../ui/ai/ready.ts'
import { Button } from '../../ui/components/Button.tsx'
import base from '../DeckImport/DeckImport.module.css'
import { DeckUnitList } from '../DeckImport/DeckUnitList.tsx'
import { deckErrorMessage, type LoadedDeck, loadDeck, unitCount, unitName } from '../DeckImport/deckSource.ts'
import { useUnitThumbs } from '../DeckImport/thumbs.ts'
import { GENERATE_QUERY } from '../Generate/open.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'

/**
 * A slide deck or a structured document, read unit by unit from its stored file (the extracted text is a local
 * cache, never in the doc). A citation (`?page=N`) scrolls to unit N and marks it.
 */
export function DeckView({ source, cited }: { source: SourceRecord; cited: number | undefined }) {
  const t = useT()
  const rt = useRuntime()
  const ready = useAiReady()
  const [, navigate] = useLocation()
  const [loaded, setLoaded] = useState<LoadedDeck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const thumbs = useUnitThumbs(loaded)
  useEffect(() => {
    let live = true
    setError(null)
    loadDeck(rt, source).then(
      (l) => {
        if (live) setLoaded(l)
      },
      (e: unknown) => {
        noteError('deck.view', e)
        if (live) setError(deckErrorMessage(t, e))
      },
    )
    return () => {
      live = false
    }
  }, [rt, source, t])

  const citedUnit = cited === undefined ? undefined : loaded?.deck.units.find((u) => u.index === cited)
  return (
    <div className={base.stack}>
      {(ready || loaded) && (
        <div className={base.row}>
          {ready && (
            // The slides or sections chosen in « Create cards », proposed unit by unit in « Suggested cards ».
            <Button
              variant="primary"
              icon={<Sparkles size={18} aria-hidden="true" />}
              onClick={() => navigate(`${to.source(source.id)}?${GENERATE_QUERY}`, { replace: true })}
            >
              {t('ai.deckCreateQuestions')}
            </Button>
          )}
          {loaded && <span className={base.hint}>{unitCount(t, loaded.deck)}</span>}
        </div>
      )}
      {error !== null && (
        <p className={base.error} role="alert">
          {error}
        </p>
      )}
      {error === null && loaded === null && (
        <p className={base.hint} role="status">
          {t('ai.deckLoading')}
        </p>
      )}
      {citedUnit && (
        <p className={base.hint} role="status">
          {t('ai.deckCited', { name: unitName(t, citedUnit) })}
        </p>
      )}
      {loaded &&
        (loaded.deck.units.length === 0 ? (
          <p className={base.hint}>{t('ai.deckEmpty')}</p>
        ) : (
          <DeckUnitList deck={loaded.deck} thumbs={thumbs} detail="full" level={2} cited={citedUnit?.index} />
        ))}
    </div>
  )
}
