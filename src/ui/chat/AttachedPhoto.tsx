import { Link } from 'wouter'
import { to } from '../../app/routes.ts'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import { getPhoto, photoLabel } from '../../core/model/photos'
import { useT } from '../../i18n/react.tsx'
import { useThumbs } from '../../screens/Photos/files.ts'
import styles from './Study.module.css'

/** The photo an earlier question was about, on the student's side of the thread, opening the photo. */
export function AttachedPhoto({ photoId }: { photoId: string }) {
  const t = useT()
  const ws = useWorkspace()
  const photo = getPhoto(ws, photoId)
  const thumb = useThumbs(photo ? [photo.blobId] : []).get(photo?.blobId ?? '')
  if (!photo) return null
  const name = photoLabel(photo)
  return (
    <Link href={to.photo(photo.id)} className={styles.attached} aria-label={t('photos.aiOpenPhoto', { name })}>
      {thumb?.kind === 'ready' ? (
        <img className={styles.attachedImage} src={thumb.url} alt="" data-rotation={photo.rotation} />
      ) : (
        <span className={styles.attachedImage} aria-hidden="true" />
      )}
    </Link>
  )
}
