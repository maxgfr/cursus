import { FolderInput, Images, ListChecks } from 'lucide-react'
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
import { Button } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { MoveSheet, moveItemTo, type Place } from '../../ui/MoveSheet.tsx'
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
  // Picking photos to move them together: `null` when not picking.
  const [picked, setPicked] = useState<ReadonlySet<Id> | null>(null)
  const [movingPhotos, setMovingPhotos] = useState(false)
  const [moved, setMoved] = useState<string | null>(null)
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
    setMoved(null)
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
  // Only the picked photos still listed here: one synced away meanwhile stays where it went.
  const pickedList = picked === null ? [] : photos.filter((p) => picked.has(p.id))
  const pickedPhotos = pickedList.map((p) => p.id)
  // The gallery lists its sections' photos too: « here » is where the picked ones are, none when they are spread.
  const pickedAt = new Set(pickedList.map((p) => p.sectionId ?? null))
  const pickedHere: Place | null =
    pickedAt.size === 0
      ? { courseId, sectionId: sectionId ?? null }
      : pickedAt.size === 1
        ? { courseId, sectionId: [...pickedAt][0] ?? null }
        : null
  // The « Photos added » notice would sit over the last tiles to pick: it has been read.
  const startPicking = () => {
    setAdded(null)
    setPicked(new Set())
  }
  const pick = (id: Id, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const movePhotos = (dest: Place) =>
    rt.ws.atomic(() => {
      for (const id of pickedPhotos) moveItemTo(rt.ws, 'sources', id, dest)
    })
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
      {photos.length > 0 && picked === null && (
        <div className={styles.actions}>
          {picker}
          <Button variant="plain" icon={<ListChecks size={18} aria-hidden="true" />} onClick={startPicking}>
            {t('photos.pick')}
          </Button>
        </div>
      )}
      {photos.length > 0 && picked !== null && (
        <div className={styles.actions}>
          <Button
            variant="primary"
            icon={<FolderInput size={18} aria-hidden="true" />}
            disabled={pickedPhotos.length === 0}
            aria-haspopup="dialog"
            onClick={() => setMovingPhotos(true)}
          >
            {t('photos.movePhotos', { count: pickedPhotos.length })}
          </Button>
          {pickedPhotos.length < photos.length ? (
            <Button variant="plain" onClick={() => setPicked(new Set(photos.map((p) => p.id)))}>
              {t('course.pickAll')}
            </Button>
          ) : (
            <Button variant="plain" onClick={() => setPicked(new Set())}>
              {t('course.pickNone')}
            </Button>
          )}
          <Button variant="plain" onClick={() => setPicked(null)}>
            {t('common.done')}
          </Button>
        </div>
      )}
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
          {picked === null ? (
            <PhotoGrid label={t('photos.galleryOf', { place })} items={tiles} />
          ) : (
            <PhotoGrid label={t('photos.galleryOf', { place })} items={tiles} picked={picked} onPickedChange={pick} />
          )}
        </section>
      )}
      <MoveSheet
        open={movingPhotos}
        title={t('photos.movePhotos', { count: pickedPhotos.length })}
        onClose={() => setMovingPhotos(false)}
        current={pickedHere}
        onMove={movePhotos}
        onMoved={(path) => {
          setAdded(null)
          setMoved(t('photos.photosMoved', { count: pickedPhotos.length, place: path }))
          setPicked(null)
        }}
      />
      {moved !== null && trashed === null && (
        <Toast message={moved} actions={[{ label: t('common.dismiss'), onClick: () => setMoved(null) }]} />
      )}
      {added !== null && trashed === null && moved === null && (
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
