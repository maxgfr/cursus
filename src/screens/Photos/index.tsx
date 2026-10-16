import { Images } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useParams } from 'wouter'
import { clearEntryState } from '../../app/nav.ts'
import { type Captured, usePasteCapture } from '../../app/paste.ts'
import { to } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id, StudyScope } from '../../core/contracts/workspace'
import { listPhotos, photoLabel } from '../../core/model/photos'
import { useT } from '../../i18n/react.tsx'
import { Breadcrumb } from '../../ui/Breadcrumb.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { PhotoGrid, type PhotoTile } from '../../ui/PhotoGrid.tsx'
import { PhotoPicker } from '../../ui/PhotoPicker.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import NotFound from '../NotFound/index.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { type CaptureFailure, capturePhotos } from './capture.ts'
import { Failures } from './Failures.tsx'
import { useThumbs } from './files.ts'
import styles from './Photos.module.css'
import { useUntitled } from './text.ts'

/** History state the viewer leaves when it trashes a photo: the gallery offers Undo. */
export interface PhotoNotice {
  trashedPhoto?: string
}

const trashedFrom = (state: unknown): string | null => {
  if (typeof state !== 'object' || state === null || !('trashedPhoto' in state)) return null
  return typeof state.trashedPhoto === 'string' ? state.trashedPhoto : null
}

/** The photos of a course or one of its subsets (descendants included), newest first, and the ways to add some. */
export default function Photos() {
  const t = useT()
  const rt = useRuntime()
  const { id: courseId = '', sectionId } = useParams<{ id: string; sectionId?: string }>()
  const [busy, setBusy] = useState<number | null>(null)
  const [added, setAdded] = useState<number | null>(null)
  const [failed, setFailed] = useState<CaptureFailure[]>([])
  const [trashed, setTrashed] = useState<string | null>(() => trashedFrom(history.state))
  const untitled = useUntitled()

  const data = useWorkspaceData(['courses', 'sections', 'sources'], (ws) => {
    const course = ws.courses.get(courseId)
    if (!course || course.deletedAt !== undefined) return null
    const tree = ws.sections.tree()
    if (sectionId !== undefined) {
      const s = tree.get(sectionId)
      if (!s || s.courseId !== courseId || tree.hidden(sectionId)) return null
    }
    const scope: StudyScope = sectionId === undefined ? { courseId } : { courseId, sectionId }
    return {
      course,
      chain: sectionId === undefined ? [] : tree.chain(sectionId),
      photos: listPhotos(ws, scope),
    }
  })
  const blobIds = useMemo(() => data?.photos.map((p) => p.blobId) ?? [], [data])
  const thumbs = useThumbs(blobIds)

  const add = (files: readonly (Blob & { name?: string })[]) => {
    if (files.length === 0 || busy !== null) return
    setBusy(files.length)
    setAdded(null)
    setFailed([])
    const where: { courseId: Id; sectionId?: Id } = sectionId === undefined ? { courseId } : { courseId, sectionId }
    capturePhotos(rt, where, files, untitled)
      .then(
        (r) => {
          setFailed(r.failed)
          if (r.ids.length > 0) setAdded(r.ids.length)
        },
        (e: unknown) => {
          noteError('photos.capture', e)
          setFailed(files.map((f) => ({ name: f.name?.trim() || '—', reason: 'unreadable' })))
        },
      )
      .finally(() => setBusy(null))
  }

  usePasteCapture(
    (c: Captured) => {
      if (c.kind === 'image') add([Object.assign(c.blob, { name: c.name })])
    },
    { enabled: data !== null },
  )

  if (data === null) return <NotFound />
  const { course, chain, photos } = data
  const place = chain.at(-1)?.name ?? course.title
  const back = to.place(courseId, sectionId)
  const tiles: PhotoTile[] = photos.map((p) => ({
    id: p.id,
    label: photoLabel(p),
    rotation: p.rotation,
    thumb: thumbs.get(p.blobId) ?? { kind: 'loading' },
    href: to.photo(p.id),
  }))
  const dismissTrashed = () => {
    setTrashed(null)
    clearEntryState()
  }
  const picker = <PhotoPicker onFiles={add} busy={busy !== null} variant="primary" />

  return (
    <Screen title={t('photos.title')} back={back}>
      <Breadcrumb
        label={t('course.breadcrumb')}
        crumbs={[
          { label: course.title, href: to.course(courseId) },
          ...chain.map((s) => ({ label: s.name, href: to.section(courseId, s.id) })),
        ]}
        current={t('photos.title')}
      />
      {photos.length > 0 && picker}
      <p className={styles.hint}>{t('photos.dropHint')}</p>
      {busy !== null && (
        <p className={styles.note} role="status">
          {t('photos.adding', { count: busy })}
        </p>
      )}
      <Failures failed={failed} className={styles.errors} />
      {photos.length === 0 ? (
        <EmptyState icon={Images} title={t('photos.emptyTitle')} body={t('photos.emptyBody')} action={picker} />
      ) : (
        <section className={styles.gallery} aria-labelledby="photos-count">
          <h2 id="photos-count" className={styles.count}>
            {t('photos.count', { count: photos.length })}
          </h2>
          <PhotoGrid label={t('photos.galleryOf', { place })} items={tiles} />
        </section>
      )}
      {added !== null && trashed === null && (
        <Toast
          message={t('photos.added', { count: added })}
          actions={[{ label: t('common.dismiss'), onClick: () => setAdded(null) }]}
        />
      )}
      {trashed !== null && (
        <Toast
          message={t('photos.trashed')}
          actions={[
            {
              label: t('course.undo'),
              onClick: () => {
                rt.ws.sources.restore(trashed)
                dismissTrashed()
              },
            },
            { label: t('common.dismiss'), onClick: dismissTrashed },
          ]}
        />
      )}
    </Screen>
  )
}
