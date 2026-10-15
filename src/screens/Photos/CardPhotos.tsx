import { Images, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type * as Y from 'yjs'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { photosIn, withoutPhoto, withPhoto } from '../../core/content/photos'
import type { Id } from '../../core/contracts/workspace'
import { getPhoto, listPhotos, photoLabel } from '../../core/model/photos'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { PhotoGrid } from '../../ui/PhotoGrid.tsx'
import { PhotoPicker } from '../../ui/PhotoPicker.tsx'
import { applyForward } from '../History/replay.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './CardPhotos.module.css'
import { type CaptureFailure, capturePhotos } from './capture.ts'
import { Failures } from './Failures.tsx'
import { useThumbs } from './files.ts'
import { useUntitled } from './text.ts'

export interface CardPhotosProps {
  /** The draft side (a scratch Y.Text, never the card's): photos go in as Markdown images. */
  text: Y.Text
  /** Its current value, to list the photos it shows. */
  value: string
  courseId: Id
  sectionId?: Id
  /** The side's name, for the remove buttons' context. */
  side: string
}

/**
 * A card side's photos: the ones it shows (each removable), a new one from the camera or the library (also kept
 * in the course's photos), or one picked among the course's photos.
 */
export default function CardPhotos({ text, value, courseId, sectionId, side }: CardPhotosProps) {
  const t = useT()
  const rt = useRuntime()
  const [busy, setBusy] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [failed, setFailed] = useState<CaptureFailure[]>([])
  const untitled = useUntitled()
  const shown = useMemo(() => photosIn(value), [value])
  const thumbs = useThumbs(useMemo(() => shown.map((p) => p.blobId), [shown]))
  const course = useWorkspaceData(['sources', 'sections'], (ws) => listPhotos(ws, { courseId }))
  const courseThumbs = useThumbs(useMemo(() => (choosing ? course.map((p) => p.blobId) : []), [choosing, course]))

  const insert = (blobId: string, alt: string) => applyForward(text, withPhoto(text.toString(), blobId, alt))

  const add = (files: File[]) => {
    setBusy(true)
    setFailed([])
    capturePhotos(rt, sectionId === undefined ? { courseId } : { courseId, sectionId }, files, untitled)
      .then(
        (r) => {
          setFailed(r.failed)
          r.ids.forEach((id, i) => {
            const photo = getPhoto(rt.ws, id)
            const blobId = r.blobIds[i]
            if (blobId !== undefined) insert(blobId, photo ? photoLabel(photo) : '')
          })
        },
        (e: unknown) => {
          noteError('photos.capture', e)
          setFailed(files.map((f) => ({ name: f.name, reason: 'unreadable' })))
        },
      )
      .finally(() => setBusy(false))
  }

  return (
    <div className={styles.photos}>
      {shown.length > 0 && (
        <ul className={styles.list} aria-label={`${t('photos.title')} · ${side}`}>
          {shown.map((p) => {
            const thumb = thumbs.get(p.blobId)
            const name = p.alt || t('photos.cardPhoto')
            return (
              <li key={p.blobId} className={styles.item} data-testid="card-photo">
                {thumb?.kind === 'ready' ? (
                  <img className={styles.thumb} src={thumb.url} alt={name} />
                ) : (
                  <span className={styles.thumb} role="img" aria-label={name}>
                    <Images size={20} aria-hidden="true" />
                  </span>
                )}
                <IconButton
                  className={styles.remove}
                  icon={X}
                  label={t('photos.removeFromCard', { name })}
                  onClick={() => applyForward(text, withoutPhoto(text.toString(), p.blobId))}
                />
              </li>
            )
          })}
        </ul>
      )}
      <div className={styles.actions}>
        <PhotoPicker onFiles={add} busy={busy} variant="plain" addLabel={t('photos.addToCard')} />
        <Button variant="plain" icon={<Images size={18} aria-hidden="true" />} onClick={() => setChoosing(true)}>
          {t('photos.fromCourse')}
        </Button>
      </div>
      <Failures failed={failed} className={styles.errors} />
      <Sheet open={choosing} title={t('photos.chooseTitle')} onClose={() => setChoosing(false)}>
        {course.length === 0 ? (
          <p className={styles.empty}>{t('photos.chooseEmpty')}</p>
        ) : (
          <PhotoGrid
            label={t('photos.chooseTitle')}
            items={course.map((p) => ({
              id: p.id,
              label: photoLabel(p),
              rotation: p.rotation,
              thumb: courseThumbs.get(p.blobId) ?? { kind: 'loading' },
            }))}
            onSelect={(id) => {
              const photo = course.find((p) => p.id === id)
              if (photo) insert(photo.blobId, photoLabel(photo))
              setChoosing(false)
            }}
          />
        )}
      </Sheet>
    </div>
  )
}
