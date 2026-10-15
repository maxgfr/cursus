import {
  Check,
  ChevronLeft,
  ChevronRight,
  FolderInput,
  Layers,
  Link2,
  NotebookPen,
  RotateCcw,
  RotateCw,
  Share,
  Sparkles,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'wouter'
import { goBack, leaveTo } from '../../app/nav.ts'
import { to } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { renderPhoto, withPhoto } from '../../core/content/photos'
import { blobStore } from '../../core/log/blobs'
import { attachableSources, attachPhoto, getPhoto, listPhotos, photoLabel, rotatePhoto } from '../../core/model/photos'
import { useT } from '../../i18n/react.tsx'
import { ChatButton } from '../../ui/chat/ChatButton.tsx'
import { useChatContext } from '../../ui/chat/context.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { MoveSheet, moveItemTo } from '../../ui/MoveSheet.tsx'
import { EMPTY, keepDraft, newCardId, readDraft } from '../CardEditor/draft.ts'
import NotFound from '../NotFound/index.tsx'
import type { PhotoNotice } from '../Photos/index.tsx'
import { sharePhoto } from '../Photos/share.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './PhotoViewer.module.css'
import { clampZoom, Stage } from './Stage.tsx'

const AiPanel = lazy(() => import('./AiPanel'))

const STEP = 1.5

/** Typing in a field keeps its keys: the viewer's shortcuts only act elsewhere. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** Full-screen photo: zoom, rotation, caption, attachment to a source, a card from it, share, move, trash. */
export default function PhotoViewer() {
  const t = useT()
  const rt = useRuntime()
  const ws = rt.ws
  const [, navigate] = useLocation()
  const { id = '' } = useParams<{ id: string }>()
  const [zoom, setZoom] = useState(1)
  const [file, setFile] = useState<Blob | null>(null)
  const [caption, setCaptionDraft] = useState<{ id: string; text: string } | null>(null)
  const [attaching, setAttaching] = useState(false)
  const [moving, setMoving] = useState(false)
  const [ai, setAi] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [working, setWorking] = useState<'card' | 'share' | null>(null)

  const data = useWorkspaceData(['sources', 'sections', 'courses', { id }], (w) => {
    const photo = getPhoto(w, id)
    if (!photo) return null
    const course = w.courses.get(photo.courseId)
    if (!course || course.deletedAt !== undefined) return null
    const sectionId = w.sections.tree().sectionOf(photo)
    const siblings = listPhotos(w, { courseId: photo.courseId }).map((p) => p.id)
    const attached = photo.attachedTo === undefined ? undefined : w.sources.get(photo.attachedTo)
    return {
      photo,
      sectionId,
      siblings,
      attached: attached && attached.deletedAt === undefined ? attached : undefined,
      attachable: attachableSources(w, photo.courseId),
    }
  })

  useChatContext(data ? { courseId: data.photo.courseId, sourceId: data.photo.id } : {})

  // A new photo starts fitted.
  const [shownId, setShownId] = useState(id)
  if (shownId !== id) {
    setShownId(id)
    setZoom(1)
    setFile(null)
    setAi(false)
  }

  const gallery = data ? to.photos(data.photo.courseId, data.sectionId) : null
  // Back to where the photo was opened from (a gallery, a card, a source), else its own gallery.
  const close = useCallback(() => goBack(gallery ?? '/'), [gallery])

  const index = data ? data.siblings.indexOf(id) : -1
  const prevId = data && index > 0 ? data.siblings[index - 1] : undefined
  const nextId = data && index >= 0 && index < data.siblings.length - 1 ? data.siblings[index + 1] : undefined
  const goTo = useCallback(
    (other: string | undefined) => {
      if (other !== undefined) navigate(to.photo(other), { replace: true })
    },
    [navigate],
  )

  const turn = useCallback((by: 90 | -90) => rotatePhoto(ws, id, by), [ws, id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('dialog[open]')) return
      const act: Record<string, () => void> = {
        '+': () => setZoom((z) => clampZoom(z * STEP)),
        '=': () => setZoom((z) => clampZoom(z * STEP)),
        '-': () => setZoom((z) => clampZoom(z / STEP)),
        '0': () => setZoom(1),
        r: () => turn(90),
        R: () => turn(-90),
        Escape: close,
        ArrowLeft: () => goTo(prevId),
        ArrowRight: () => goTo(nextId),
      }
      const fn = act[e.key]
      // Arrows pan a zoomed photo (the stage scrolls); they browse when it is fitted.
      if (!fn || ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && zoom > 1)) return
      e.preventDefault()
      fn()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [turn, close, goTo, prevId, nextId, zoom])

  if (data === null || gallery === null) return <NotFound />
  const { photo, sectionId } = data
  const label = photoLabel(photo)
  const captionText = caption?.id === id ? caption.text : photo.caption

  const saveCaption = () => {
    if (caption?.id !== id || caption.text.trim() === photo.caption) return
    ws.sources.update(id, { caption: caption.text.trim() === '' ? undefined : caption.text.trim() })
    setCaptionDraft(null)
    setToast(t('photos.captionSaved'))
  }

  const makeCard = async () => {
    setWorking('card')
    try {
      let blobId = photo.blobId
      // A turned photo goes on the card as it is shown.
      if (photo.rotation !== 0 && file !== null) {
        const turned = await renderPhoto(file, photo.rotation)
        blobId = await blobStore(rt.store).put(new Uint8Array(await turned.arrayBuffer()), turned.type || 'image/jpeg')
      }
      const cardId = newCardId(photo.courseId, sectionId ?? undefined)
      // An unsaved new card of this place keeps its text: the photo is added to it.
      const kept = await readDraft(rt.store, cardId)
      const fields = kept?.fields ?? EMPTY
      await keepDraft(
        rt.store,
        cardId,
        { ...fields, front: withPhoto(fields.front, blobId, label) },
        { ...EMPTY, kind: fields.kind },
      )
      navigate(to.card(cardId))
    } catch (e) {
      noteError('photos.card', e)
      setToast(t('photos.actionFailed'))
    } finally {
      setWorking(null)
    }
  }

  const share = async () => {
    if (file === null) return
    setWorking('share')
    try {
      const outcome = await sharePhoto(file, { rotation: photo.rotation, label, caption: photo.caption })
      if (outcome !== 'cancelled') setToast(outcome === 'shared' ? t('photos.shared') : t('photos.downloaded'))
    } catch (e) {
      noteError('photos.share', e)
      setToast(t('photos.actionFailed'))
    } finally {
      setWorking(null)
    }
  }

  const trash = () => {
    ws.sources.trash(id)
    const notice: PhotoNotice = { trashedPhoto: id }
    leaveTo(gallery, notice)
  }

  return (
    <div className={styles.viewer}>
      <header className={styles.bar}>
        <IconButton icon={X} label={t('photos.close')} onClick={close} />
        <div className={styles.heading}>
          <h1 className={styles.title}>{photo.title}</h1>
          {data.siblings.length > 1 && index >= 0 && (
            <p className={styles.position}>{t('photos.position', { index: index + 1, total: data.siblings.length })}</p>
          )}
        </div>
        <IconButton
          icon={Share}
          label={t('photos.share')}
          onClick={() => void share()}
          disabled={file === null || working !== null}
        />
        <ChatButton />
      </header>

      <div className={styles.main}>
        <div className={styles.view}>
          <Stage
            blobId={photo.blobId}
            rotation={photo.rotation}
            label={label}
            zoom={zoom}
            onZoom={setZoom}
            onFile={setFile}
          />
          <div className={styles.tools} role="toolbar" aria-label={t('photos.title')}>
            <IconButton
              icon={ChevronLeft}
              label={t('photos.previous')}
              onClick={() => goTo(prevId)}
              disabled={!prevId}
            />
            <IconButton
              icon={ZoomOut}
              label={t('photos.zoomOut')}
              onClick={() => setZoom((z) => clampZoom(z / STEP))}
              disabled={zoom <= 1}
            />
            <button
              type="button"
              className={styles.zoom}
              onClick={() => setZoom(1)}
              aria-label={t('photos.zoomFit')}
              title={t('photos.zoomFit')}
            >
              <span aria-live="polite">{t('photos.zoomLevel', { percent: Math.round(zoom * 100) })}</span>
            </button>
            <IconButton icon={ZoomIn} label={t('photos.zoomIn')} onClick={() => setZoom((z) => clampZoom(z * STEP))} />
            <IconButton icon={RotateCcw} label={t('photos.rotateLeft')} onClick={() => turn(-90)} />
            <IconButton icon={RotateCw} label={t('photos.rotateRight')} onClick={() => turn(90)} />
            <IconButton icon={ChevronRight} label={t('photos.next')} onClick={() => goTo(nextId)} disabled={!nextId} />
          </div>
          <p className={styles.keys}>{t('photos.shortcuts')}</p>
        </div>

        <div className={styles.details}>
          <Field
            label={t('photos.caption')}
            placeholder={t('photos.captionPlaceholder')}
            value={captionText}
            enterKeyHint="done"
            onChange={(e) => setCaptionDraft({ id, text: e.currentTarget.value })}
            onBlur={saveCaption}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                saveCaption()
              }
            }}
          />
          {data.attached && (
            <p className={styles.attached}>
              <Link2 size={16} aria-hidden="true" />
              <Link href={to.source(data.attached.id)} className={styles.link}>
                {t('photos.attachedTo', { name: data.attached.title })}
              </Link>
            </p>
          )}
          <div className={styles.actions}>
            <Button
              variant="primary"
              icon={<Layers size={18} aria-hidden="true" />}
              onClick={() => void makeCard()}
              loading={working === 'card'}
              disabled={working !== null || (photo.rotation !== 0 && file === null)}
            >
              {t('photos.makeCard')}
            </Button>
            <Button
              icon={<Sparkles size={18} aria-hidden="true" />}
              onClick={() => setAi((v) => !v)}
              aria-expanded={ai}
            >
              {t('photos.explain')}
            </Button>
          </div>
          {ai && (
            <Suspense fallback={<p className={styles.keys}>{t('common.loading')}</p>}>
              <AiPanel photoId={photo.id} courseId={photo.courseId} onClose={() => setAi(false)} />
            </Suspense>
          )}
          <div className={styles.actions}>
            <Button variant="plain" icon={<Link2 size={18} aria-hidden="true" />} onClick={() => setAttaching(true)}>
              {t('photos.attach')}
            </Button>
            <Link href={to.source(photo.id)} className={buttonClass({ variant: 'plain' })}>
              <NotebookPen size={18} aria-hidden="true" />
              {t('photos.notes')}
            </Link>
            <Button variant="plain" icon={<FolderInput size={18} aria-hidden="true" />} onClick={() => setMoving(true)}>
              {t('course.moveTo')}
            </Button>
            <Button variant="danger" icon={<Trash2 size={18} aria-hidden="true" />} onClick={trash}>
              {t('course.moveToTrash')}
            </Button>
          </div>
        </div>
      </div>

      <Sheet open={attaching} title={t('photos.attach')} onClose={() => setAttaching(false)}>
        {data.attachable.length === 0 ? (
          <p className={styles.keys}>{t('photos.attachEmpty')}</p>
        ) : (
          <ListGroup title={t('photos.attach')} hideTitle>
            {[{ id: null, title: t('photos.attachNone') }, ...data.attachable].map((s) => {
              const current = (photo.attachedTo ?? null) === s.id
              return (
                <ListRow
                  key={s.id ?? 'none'}
                  title={
                    <>
                      {s.title}
                      {current && <span className="sr-only">{` · ${t('photos.current')}`}</span>}
                    </>
                  }
                  trailing={current ? <Check size={18} aria-hidden="true" /> : undefined}
                  onClick={() => {
                    attachPhoto(ws, photo.id, s.id)
                    setAttaching(false)
                  }}
                />
              )
            })}
          </ListGroup>
        )}
      </Sheet>
      <MoveSheet
        open={moving}
        title={t('course.moveTitle')}
        onClose={() => setMoving(false)}
        current={{ courseId: photo.courseId, sectionId }}
        onMove={(place) => moveItemTo(ws, 'sources', photo.id, place)}
        onMoved={(path) => setToast(t('course.moved', { place: path }))}
      />
      {toast !== null && (
        <Toast message={toast} actions={[{ label: t('common.dismiss'), onClick: () => setToast(null) }]} />
      )}
    </div>
  )
}
