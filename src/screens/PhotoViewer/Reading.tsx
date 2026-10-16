import { Layers, MessageCircle, NotebookPen, RotateCcw, ScrollText, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { VisionRequiredError } from '../../core/ai/features/describePhoto'
import type { PhotoDescription } from '../../core/ai/schemas'
import type { Id } from '../../core/contracts/workspace'
import { getPhoto } from '../../core/model/photos'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { PartialPhoto, Reading as ReadingView } from '../../ui/ai/PhotoReading.tsx'
import { useChat } from '../../ui/chat/context.tsx'
import { usePhotoImages } from '../../ui/chat/photoImages.ts'
import { chunkLoader, runPhoto } from '../../ui/chat/studyRun.ts'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { usePartial } from '../../ui/data/usePartial.ts'
import { useCanCallAi } from '../../ui/ExplainLauncher.tsx'
import { createFiche, WRITE_QUERY } from '../Fiche/create.ts'
import { describeFailure } from '../Review/failure.ts'
import shared from '../Understand/shared/ai.module.css'
import { useAiModel } from '../Understand/shared/aiConfig.ts'

/** A reading as Markdown, added to the photo's notes. */
function readingMarkdown(t: ReturnType<typeof useT>, d: PhotoDescription): string {
  const parts = [`## ${d.title}`]
  if (d.transcription.trim() !== '') parts.push(d.transcription.trim())
  if (d.explanation.trim() !== '') parts.push(d.explanation.trim())
  if (d.keyPoints.length > 0) parts.push(`${t('photos.aiKeyPoints')}\n\n${d.keyPoints.map((k) => `- ${k}`).join('\n')}`)
  return parts.join('\n\n')
}

/**
 * The photo read by a vision model, right here: what was read before on this device shows at once (« Read again »
 * asks anew), kept for study sheets to cite. Then « Add to my notes » (undoable), « Create cards » from it, and
 * « Continue in the chat ». A text-only model says it cannot read photos.
 */
export default function Reading({ photoId, onCards }: { photoId: Id; onCards: () => void }) {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const chat = useChat()
  const [, navigate] = useLocation()
  const ai = useAiModel()
  const callable = useCanCallAi(ai)
  const images = usePhotoImages()
  const stream = usePartial<PhotoDescription>()
  const load = useMemo(() => chunkLoader(rt.ws, rt), [rt])
  const [description, setDescription] = useState<PhotoDescription | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState<{ at: number; length: number } | null>(null)
  const [toast, setToast] = useState(false)
  const [needsSettings, setNeedsSettings] = useState(false)
  // What the last request cost (none when the reading kept on this device showed again).
  const [cost, setCost] = useState<number | null>(null)
  const result = useRef<HTMLDivElement>(null)
  const abort = useRef<AbortController | null>(null)
  const ready = ai.status === 'ready' ? ai : null
  const { reset, onPartial } = stream

  const read = useCallback(
    (again: boolean) => {
      if (!ready) return
      abort.current?.abort()
      const ctl = new AbortController()
      abort.current = ctl
      setBusy(true)
      setError(null)
      setNeedsSettings(false)
      reset()
      runPhoto({ ws: rt.ws, rt, ai: ready, t, load }, photoId, images, again, { signal: ctl.signal, onPartial })
        .then((rich) => {
          if (ctl.signal.aborted) return
          if (rich?.kind !== 'photo') return
          setDescription(rich.description as PhotoDescription)
          setCost(rich.cost ?? null)
          // Read for the student: focus goes to the result, so a screen reader reads it next.
          requestAnimationFrame(() => result.current?.focus())
        })
        .catch((e: unknown) => {
          if (ctl.signal.aborted) return
          console.warn('photo not read', e)
          setNeedsSettings(e instanceof VisionRequiredError && !ready.runsOffline)
          setError(
            e instanceof VisionRequiredError
              ? ready.runsOffline
                ? t('photos.aiOnDeviceTextOnly')
                : t('photos.aiNeedVision', { model: ready.info.name })
              : t('chat.failed', { reason: describeFailure(e, t) }),
          )
        })
        .finally(() => {
          if (abort.current === ctl) {
            abort.current = null
            setBusy(false)
            reset()
          }
        })
    },
    [ready, rt, t, load, photoId, images, reset, onPartial],
  )
  useEffect(() => {
    read(false)
    return () => abort.current?.abort()
  }, [read])

  const addToNotes = () => {
    if (!description) return
    const notes = rt.ws.text({ id: photoId, field: 'body' })
    const before = notes.length === 0 ? '' : '\n\n'
    const text = `${before}${readingMarkdown(t, description)}`
    const at = notes.length
    rt.ws.batch(() => notes.insert(at, text))
    setAdded({ at, length: text.length })
    setToast(true)
  }
  const stop = () => {
    abort.current?.abort()
    abort.current = null
    setBusy(false)
    reset()
  }
  // A study sheet of the photo's place, on what was read on it.
  const writeSheet = () => {
    const photo = getPhoto(rt.ws, photoId)
    if (!photo || !description) return
    const place = photo.sectionId
      ? { courseId: photo.courseId, sectionId: photo.sectionId }
      : { courseId: photo.courseId }
    const sources = rt.ws.scoped('sources', place).map((s) => s.id)
    navigate(`${to.fiche(createFiche(rt.ws, place, description.title, sources))}?${WRITE_QUERY}`)
  }
  const undoAdd = () => {
    if (!added) return
    const notes = rt.ws.text({ id: photoId, field: 'body' })
    rt.ws.batch(() => notes.delete(added.at, Math.min(added.length, notes.length - added.at)))
    setAdded(null)
    setToast(false)
  }

  return (
    <section className={shared.stack} aria-label={t('chat.actionExplainPhoto')} aria-busy={busy || undefined}>
      {busy && !description && <PartialPhoto partial={stream.partial} />}
      {busy && (
        <div className={shared.row}>
          <Button variant="secondary" icon={<Square size={18} aria-hidden="true" />} onClick={stop}>
            {t('chat.stop')}
          </Button>
        </div>
      )}
      {description && (
        <div ref={result} className={shared.stack} tabIndex={-1}>
          <ReadingView description={description} />
        </div>
      )}
      {description && cost !== null && ready && (
        <>
          <p className={shared.hint}>
            {t('ai.cost', { amount: formatUsd(locale, cost) })} · {ready.info.name}
          </p>
          <p className={shared.hint}>{t('photos.aiReduced', { size: 1024 })}</p>
        </>
      )}
      {description && <p className={shared.hint}>{t('photos.aiCiteable')}</p>}
      {error && (
        <div className={shared.stack} role="alert">
          <p className={shared.error}>{error}</p>
          {needsSettings && (
            <Link href={paths.settingsAi} className={buttonClass({ variant: 'plain' })}>
              {t('ai.openSettings')}
            </Link>
          )}
        </div>
      )}
      {!callable && <p className={shared.hint}>{t('ai.explainOffline')}</p>}
      {!busy && (
        <div className={shared.row}>
          {description && (
            <Button icon={<NotebookPen size={18} aria-hidden="true" />} disabled={added !== null} onClick={addToNotes}>
              {t('photos.aiAddToNotes')}
            </Button>
          )}
          {description && (
            <Button variant="plain" icon={<ScrollText size={18} aria-hidden="true" />} onClick={writeSheet}>
              {t('chat.actionWriteSheet')}
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<Layers size={18} aria-hidden="true" />}
            disabled={!callable}
            onClick={onCards}
          >
            {t('ai.deckQuestionsTitle')}
          </Button>
          <Button
            variant="plain"
            icon={<RotateCcw size={18} aria-hidden="true" />}
            disabled={!callable}
            onClick={() => read(true)}
          >
            {t('photos.aiExplainAgain')}
          </Button>
          {chat && description && (
            <Button
              variant="plain"
              icon={<MessageCircle size={18} aria-hidden="true" />}
              onClick={() => chat.ask(t('chat.actionExplainPhoto'), readingMarkdown(t, description))}
            >
              {t('review.continueInChat')}
            </Button>
          )}
        </div>
      )}
      {toast && (
        <Toast
          message={t('photos.aiAddedToNotes')}
          actions={[
            { label: t('common.undo'), onClick: undoAdd },
            { label: t('common.dismiss'), onClick: () => setToast(false) },
          ]}
        />
      )}
    </section>
  )
}
