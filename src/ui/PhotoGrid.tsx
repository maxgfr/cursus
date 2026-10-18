import { CloudDownload, ImageOff } from 'lucide-react'
import { Link } from 'wouter'
import { useT } from '../i18n/react.tsx'
import styles from './PhotoGrid.module.css'

export interface PhotoTile {
  id: string
  /** What VoiceOver reads and what the image's alt says: the caption, else the title. */
  label: string
  rotation: 0 | 90 | 180 | 270
  /** `ready` with a thumbnail URL; `remote`: the file is still on the destinations; `failed`: no preview. */
  thumb: { kind: 'ready'; url: string } | { kind: 'remote' } | { kind: 'failed' } | { kind: 'loading' }
  /** A link to the photo… */
  href?: string
}

export interface PhotoGridProps {
  /** Names the grid for assistive tech. */
  label: string
  items: readonly PhotoTile[]
  /** …or a choice (picking a photo for a card): tiles become buttons. */
  onSelect?: (id: string) => void
  /** …or picking several (to move them together): tiles become checkboxes, these ids checked. */
  picked?: ReadonlySet<string>
  onPickedChange?: (id: string, on: boolean) => void
}

function TileBody({ tile }: { tile: PhotoTile }) {
  const t = useT()
  if (tile.thumb.kind === 'ready') {
    return <img className={styles.img} src={tile.thumb.url} alt={tile.label} data-rotation={tile.rotation} />
  }
  if (tile.thumb.kind === 'remote' || tile.thumb.kind === 'failed') {
    const Icon = tile.thumb.kind === 'remote' ? CloudDownload : ImageOff
    return (
      <span className={styles.placeholder}>
        <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles.label}>{tile.label}</span>
        <span className="sr-only">{tile.thumb.kind === 'remote' ? t('photos.notHere') : t('photos.noPreview')}</span>
      </span>
    )
  }
  return <span className={styles.placeholder} aria-label={tile.label} role="img" />
}

/** Square thumbnails, as many per row as fit (three on a phone, more on iPad and Mac). */
export function PhotoGrid({ label, items, onSelect, picked, onPickedChange }: PhotoGridProps) {
  return (
    <ul className={styles.grid} aria-label={label}>
      {items.map((tile) => (
        <li key={tile.id} className={styles.item} data-state={tile.thumb.kind} data-testid="photo-tile">
          {onPickedChange ? (
            <label className={styles.tile}>
              <input
                type="checkbox"
                className={styles.check}
                aria-label={tile.label}
                checked={picked?.has(tile.id) ?? false}
                onChange={(e) => onPickedChange(tile.id, e.currentTarget.checked)}
              />
              <TileBody tile={tile} />
            </label>
          ) : onSelect ? (
            <button type="button" className={styles.tile} onClick={() => onSelect(tile.id)}>
              <TileBody tile={tile} />
            </button>
          ) : (
            <Link href={tile.href ?? '#'} className={styles.tile}>
              <TileBody tile={tile} />
            </Link>
          )}
        </li>
      ))}
    </ul>
  )
}
