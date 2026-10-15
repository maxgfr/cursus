import { EyeOff, Image as ImageIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Deck, DeckUnit } from '../../core/content/deck'
import { useT } from '../../i18n/react.tsx'
import styles from './DeckImport.module.css'
import { unitName } from './deckSource.ts'
import type { Thumb } from './thumbs.ts'

export interface DeckUnitListProps {
  deck: Deck
  thumbs: ReadonlyMap<number, Thumb>
  /** `preview` clips each unit to a few lines; `full` shows all of its text and notes (the Source viewer). */
  detail: 'preview' | 'full'
  /** Heading level of each unit's name. */
  level?: 2 | 3
  /** The unit a citation points at: scrolled to, focused and marked. */
  cited?: number
  /** Only these units (default: all). */
  only?: ReadonlySet<number>
}

/** A deck's slides, pages or sections in order, with their picture, text and speaker notes. */
export function DeckUnitList({ deck, thumbs, detail, level = 3, cited, only }: DeckUnitListProps) {
  const t = useT()
  const citedRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (cited === undefined) return
    const el = citedRef.current
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    el.focus({ preventScroll: true })
  }, [cited])
  const units = only ? deck.units.filter((u) => only.has(u.index)) : deck.units
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <ol className={styles.units} data-detail={detail}>
      {units.map((u) => {
        const thumb = thumbs.get(u.index)
        const isCited = u.index === cited
        return (
          <li
            key={u.index}
            id={`unit-${u.index}`}
            ref={isCited ? citedRef : undefined}
            tabIndex={isCited ? -1 : undefined}
            aria-current={isCited ? 'location' : undefined}
            className={styles.unit}
            data-level={u.kind === 'section' ? Math.min(u.level ?? 1, 4) : undefined}
          >
            <div className={styles.thumb} aria-hidden={thumb?.alt ? undefined : 'true'}>
              {thumb ? (
                <img src={thumb.url} alt={thumb.alt} loading="lazy" decoding="async" />
              ) : (
                <span className={styles.thumbLabel}>{u.label === '0' ? '' : u.label}</span>
              )}
            </div>
            <div className={styles.unitBody}>
              <Heading className={styles.unitName}>
                <span className={styles.unitKind}>{unitName(t, u)}</span>
                {u.title && (
                  <>
                    {' '}
                    <span className={styles.unitTitle}>{u.title}</span>
                  </>
                )}
              </Heading>
              <UnitMeta unit={u} />
              {u.text && (
                <p className={styles.unitText} data-clip={detail === 'preview' ? 'true' : undefined}>
                  {u.text}
                </p>
              )}
              {u.notes &&
                (detail === 'full' ? (
                  <div className={styles.notes}>
                    <p className={styles.notesLabel}>{t('ai.deckNotes')}</p>
                    <p className={styles.unitText}>{u.notes}</p>
                  </div>
                ) : (
                  <p className={styles.notesLine} data-clip="true">
                    {t('ai.deckNotesInline', { notes: u.notes })}
                  </p>
                ))}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function UnitMeta({ unit }: { unit: DeckUnit }) {
  const t = useT()
  const images = unit.images.length
  if (!unit.hidden && images === 0) return null
  return (
    <p className={styles.unitMeta}>
      {unit.hidden && (
        <span className={styles.meta}>
          <EyeOff size={14} aria-hidden="true" />
          {t('ai.deckHidden')}
        </span>
      )}
      {images > 0 && (
        <span className={styles.meta}>
          <ImageIcon size={14} aria-hidden="true" />
          {t('ai.deckImages', { count: images })}
        </span>
      )}
    </p>
  )
}
