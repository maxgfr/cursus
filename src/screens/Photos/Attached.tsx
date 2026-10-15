import { useId, useMemo } from 'react'
import { to } from '../../app/routes.ts'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id } from '../../core/contracts/workspace'
import { photoLabel, photosAttachedTo } from '../../core/model/photos'
import { useT } from '../../i18n/react.tsx'
import { PhotoGrid } from '../../ui/PhotoGrid.tsx'
import styles from './Attached.module.css'
import { useThumbs } from './files.ts'

/** The photos attached to a note or PDF, shown with it (nothing when there are none). */
export default function AttachedPhotos({ sourceId }: { sourceId: Id }) {
  const t = useT()
  const photos = useWorkspaceData(['sources'], (ws) => photosAttachedTo(ws, sourceId))
  const thumbs = useThumbs(useMemo(() => photos.map((p) => p.blobId), [photos]))
  const id = useId()
  if (photos.length === 0) return null
  return (
    <section className={styles.group} aria-labelledby={id}>
      <h2 id={id} className={styles.title}>
        {t('photos.attachedPhotos')}
      </h2>
      <PhotoGrid
        label={t('photos.attachedPhotos')}
        items={photos.map((p) => ({
          id: p.id,
          label: photoLabel(p),
          rotation: p.rotation,
          thumb: thumbs.get(p.blobId) ?? { kind: 'loading' },
          href: to.photo(p.id),
        }))}
      />
    </section>
  )
}
