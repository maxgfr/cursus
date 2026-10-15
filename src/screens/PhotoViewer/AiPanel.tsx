import { Trash2, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'wouter'
import { paths, to, withScope } from '../../app/routes.ts'
import { useRuntime, useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import {
  canSeeImages,
  DESCRIBE_OUTPUT_TOKENS,
  describePhoto,
  estimatePhotoCost,
  loadReadings,
  PHOTO_MAX_EDGE,
  type PhotoImage,
  type PhotoReading,
  saveReading,
  VisionRequiredError,
} from '../../core/ai/features/describePhoto'
import { estimatePhotoCardsCost, photoToCards } from '../../core/ai/features/photoToCards'
import type { CardDraft, PhotoDescription } from '../../core/ai/schemas'
import { renderPhoto } from '../../core/content/photos'
import { getPhoto, listPhotos, type Photo, photoLabel } from '../../core/model/photos'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { cx } from '../../ui/cx.ts'
import { streamedKeys, usePartial } from '../../ui/data/usePartial.ts'
import { useCanCallAi } from '../../ui/ExplainLauncher.tsx'
import { Sanitized } from '../../ui/render/Sanitized.tsx'
import { dedupeDrafts } from '../Generate/dedupe.ts'
import { type Thumb, useFileLoader, useThumbs } from '../Photos/files.ts'
import { describeFailure } from '../Review/failure.ts'
import shared from '../Understand/shared/ai.module.css'
import { type AiModelState, courseText, useAiModel } from '../Understand/shared/aiConfig.ts'
import styles from './AiPanel.module.css'

type ReadyModel = Extract<AiModelState, { status: 'ready' }>

type Call<T> =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'done'; value: T }
  | { status: 'failed'; message: string; needsVision?: boolean }

const IDLE = { status: 'idle' } as const
const COUNTS = ['5', '10', '20'] as const

interface Draft extends CardDraft {
  key: string
}

/** The photo isn't on this device (on-demand mode, not downloaded yet). */
class PhotoUnavailableError extends Error {
  constructor(id: string) {
    super(`photo ${id} is not on this device`)
    this.name = 'PhotoUnavailableError'
  }
}

/**
 * The one place the panel reaches into the photos module: which photos the course has, and a photo's pixels as
 * sent to a model (fetched from a destination if it is not here yet, turned upright, at most `PHOTO_MAX_EDGE`
 * px, re-encoded as JPEG).
 */
function usePhotoAccess(courseId: string) {
  const ws = useWorkspace()
  const loadFile = useFileLoader()
  const photos = useWorkspaceData(['sources', 'sections', { id: courseId }], (w) => listPhotos(w, { courseId }))
  const image = useCallback(
    async (id: string): Promise<PhotoImage> => {
      const photo = getPhoto(ws, id)
      const file = photo ? await loadFile(photo.blobId) : null
      if (!photo || !file) throw new PhotoUnavailableError(id)
      const small = await renderPhoto(file, photo.rotation, PHOTO_MAX_EDGE)
      return { bytes: new Uint8Array(await small.arrayBuffer()), mediaType: small.type || 'image/jpeg' }
    },
    [ws, loadFile],
  )
  return { photos, image }
}

/** « Explain this photo » and « Create cards from this photo », in the photo viewer. Loaded on demand. */
export default function AiPanel({
  photoId,
  courseId,
  onClose,
}: {
  photoId: string
  courseId: string
  onClose?: () => void
}) {
  const t = useT()
  const ai = useAiModel()
  const online = useCanCallAi(ai)
  const headingId = useId()

  let body: ReactNode
  if (ai.status === 'loading') body = null
  else if (ai.status === 'missing') body = <NeedsSetup message={t('photos.aiNeedModel')} />
  else if (!canSeeImages(ai.info)) body = <NeedsVision ai={ai} />
  else body = <Actions key={photoId} ai={ai} photoId={photoId} courseId={courseId} online={online} />

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <div className={styles.header}>
        <h2 id={headingId} className={styles.title}>
          {t('photos.explain')}
        </h2>
        {onClose && <IconButton icon={X} label={t('photos.close')} onClick={onClose} />}
      </div>
      {body}
    </section>
  )
}

function NeedsSetup({ message }: { message: string }) {
  const t = useT()
  return (
    <div className={shared.tight}>
      <p className={shared.muted}>{message}</p>
      <Link href={paths.settingsAi} className={styles.settingsLink}>
        {t('ai.openSettings')}
      </Link>
    </div>
  )
}

function NeedsVision({ ai }: { ai: ReadyModel }) {
  const t = useT()
  const message = ai.runsOffline ? t('photos.aiOnDeviceTextOnly') : t('photos.aiNeedVision', { model: ai.info.name })
  return <NeedsSetup message={message} />
}

function Actions({
  ai,
  photoId,
  courseId,
  online,
}: {
  ai: ReadyModel
  photoId: string
  courseId: string
  online: boolean
}) {
  const t = useT()
  return (
    <>
      {!online && <p className={styles.note}>{t('photos.aiOffline')}</p>}
      <Explain ai={ai} photoId={photoId} courseId={courseId} online={online} />
      <Cards ai={ai} photoId={photoId} courseId={courseId} online={online} />
    </>
  )
}

/** Runs one request at a time, cancellable; a cancelled request settles back to idle. */
function useCall<T>() {
  const t = useT()
  const [call, setCall] = useState<Call<T>>(IDLE)
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  const run = useCallback(
    async (fn: (signal: AbortSignal) => Promise<T>) => {
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      setCall({ status: 'busy' })
      try {
        const value = await fn(controller.signal)
        if (!controller.signal.aborted) setCall({ status: 'done', value })
      } catch (error) {
        if (controller.signal.aborted) return
        console.warn('Photo AI request failed', error)
        if (error instanceof VisionRequiredError) setCall({ status: 'failed', message: '', needsVision: true })
        else if (error instanceof PhotoUnavailableError) setCall({ status: 'failed', message: t('photos.unavailable') })
        else setCall({ status: 'failed', message: describeFailure(error, t) })
      }
    },
    [t],
  )
  const cancel = useCallback(() => {
    abort.current?.abort()
    setCall((c) => (c.status === 'busy' ? IDLE : c))
  }, [])
  // Focus never falls back to the page when the busy line goes: a result takes it, else the action again.
  const result = useRef<HTMLDivElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  const previous = useRef(call.status)
  useEffect(() => {
    const was = previous.current
    previous.current = call.status
    if (was !== 'busy' || call.status === 'busy') return
    if (call.status === 'done') result.current?.focus()
    else actions.current?.querySelector('button')?.focus()
  }, [call.status])
  return { call, setCall, run, cancel, result, actions }
}

function Busy({ label, onCancel }: { label: string; onCancel: () => void }) {
  const t = useT()
  const line = useRef<HTMLDivElement>(null)
  // The pressed action gives way to this line: its Cancel takes the focus.
  useEffect(() => {
    line.current?.querySelector('button')?.focus()
  }, [])
  return (
    <div ref={line} className={styles.busy}>
      <span className={styles.spinner} aria-hidden="true" />
      <p role="status">{label}</p>
      <Button variant="plain" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </div>
  )
}

function Failure({ call, ai }: { call: Extract<Call<unknown>, { status: 'failed' }>; ai: ReadyModel }) {
  if (call.needsVision) return <NeedsVision ai={ai} />
  return (
    <p className={shared.error} role="alert">
      {call.message}
    </p>
  )
}

function Explain({
  ai,
  photoId,
  courseId,
  online,
}: {
  ai: ReadyModel
  photoId: string
  courseId: string
  online: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const ws = useWorkspace()
  const { image } = usePhotoAccess(courseId)
  const { call, setCall, run, cancel, result, actions } = useCall<PhotoReading>()
  const stream = usePartial<PhotoDescription>()

  // What was read before, on this device, shows straight away.
  useEffect(() => {
    let live = true
    loadReadings(rt.store, [photoId]).then(
      ([kept]) => {
        if (live && kept) setCall((c) => (c.status === 'idle' ? { status: 'done', value: kept } : c))
      },
      (error: unknown) => console.warn('The photo’s earlier reading could not be loaded', error),
    )
    return () => {
      live = false
    }
  }, [rt, photoId, setCall])

  const explain = () => {
    stream.reset()
    return run(async (signal) => {
      const photo = getPhoto(ws, photoId)
      const course = ws.courses.get(courseId)
      const ctx = await ai.context(signal, course?.language, courseText(ws, courseId))
      const description = await describePhoto(
        { ...ctx, onPartial: stream.onPartial },
        {
          photoId,
          image: await image(photoId),
          caption: photo?.caption,
          courseTitle: course?.title,
        },
      )
      const reading: PhotoReading = { photoId, description, model: `${ai.provider.id}/${ai.info.id}`, at: Date.now() }
      // Kept on this device so « Understand » can ground in it and cite the photo.
      await saveReading(rt.store, reading)
      return reading
    })
  }
  const writing = call.status === 'busy' ? stream.partial : null

  const cost = `${t('ai.cost', { amount: formatUsd(locale, estimatePhotoCost(ai.info, 1, DESCRIBE_OUTPUT_TOKENS)) })} · ${ai.info.name}`

  return (
    <div className={styles.block}>
      {call.status === 'busy' ? (
        <>
          <Busy label={t('photos.aiReading')} onCancel={cancel} />
          {writing?.title && (
            <div className={styles.result} aria-busy="true">
              <Reading
                description={{
                  kind: writing.kind ?? 'other',
                  title: writing.title,
                  transcription: writing.transcription ?? '',
                  explanation: writing.explanation ?? '',
                  keyPoints: (writing.keyPoints ?? []).filter((k): k is string => typeof k === 'string' && k !== ''),
                }}
              />
            </div>
          )}
        </>
      ) : (
        <div className={shared.tight}>
          <div ref={actions} className={shared.row}>
            <Button variant={call.status === 'done' ? 'secondary' : 'primary'} disabled={!online} onClick={explain}>
              {call.status === 'done' ? t('photos.aiExplainAgain') : t('photos.aiExplain')}
            </Button>
          </div>
          <p className={shared.hint}>{cost}</p>
          <p className={shared.hint}>{t('photos.aiReduced', { size: PHOTO_MAX_EDGE })}</p>
        </div>
      )}
      {call.status === 'failed' && <Failure call={call} ai={ai} />}
      {call.status === 'done' && (
        <div ref={result} tabIndex={-1} className={styles.result}>
          <Reading description={call.value.description} />
          <p className={shared.hint}>
            {t('photos.aiCiteable')}{' '}
            <Link href={withScope(paths.understand, placeOf(ws, photoId, courseId))}>{t('ai.understand')}</Link>
          </p>
        </div>
      )}
    </div>
  )
}

function placeOf(ws: ReturnType<typeof useWorkspace>, photoId: string, courseId: string) {
  const sectionId = getPhoto(ws, photoId)?.sectionId
  return sectionId ? { courseId, sectionId } : { courseId }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={shared.label}>
        {title}
      </h3>
      {children}
    </section>
  )
}

/** Items keyed by their text, repeats told apart by their rank among equals. */
function keyed(items: readonly string[]): { item: string; key: string }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const n = (seen.get(item) ?? 0) + 1
    seen.set(item, n)
    return { item, key: n === 1 ? item : `${item}#${n}` }
  })
}

function Reading({ description }: { description: PhotoDescription }) {
  const t = useT()
  return (
    <>
      {description.title && <p className={styles.lead}>{description.title}</p>}
      <Section title={t('photos.aiTranscription')}>
        {description.transcription ? (
          <div className={styles.transcription}>
            <Sanitized markdown={description.transcription} />
          </div>
        ) : (
          <p className={shared.hint}>{t('photos.aiNoText')}</p>
        )}
      </Section>
      {description.explanation && (
        <Section title={t('photos.aiExplanation')}>
          <p className={styles.body}>{description.explanation}</p>
        </Section>
      )}
      {description.keyPoints.length > 0 && (
        <Section title={t('photos.aiKeyPoints')}>
          <ul className={shared.bullets}>
            {keyed(description.keyPoints).map(({ item, key }) => (
              <li key={key}>{item}</li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

function Cards({
  ai,
  photoId,
  courseId,
  online,
}: {
  ai: ReadyModel
  photoId: string
  courseId: string
  online: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const ws = useWorkspace()
  const { photos, image } = usePhotoAccess(courseId)
  const { call, setCall, run, cancel, result, actions } = useCall<{ drafts: Draft[]; dropped: number }>()
  const stream = usePartial<{ cards: CardDraft[] }>()
  const [chosen, setChosen] = useState<string[]>([photoId])
  const [count, setCount] = useState<(typeof COUNTS)[number]>('10')
  const [saved, setSaved] = useState<number | null>(null)
  const savedLine = useRef<HTMLParagraphElement>(null)
  // The drafts leave with the save: the confirmation takes the focus.
  useEffect(() => {
    if (saved !== null) savedLine.current?.focus()
  }, [saved])
  const others = useMemo(() => photos.filter((p) => p.id !== photoId), [photos, photoId])
  // Photos trashed meanwhile drop out of the choice.
  const picked = chosen.filter((id) => id === photoId || others.some((p) => p.id === id))

  const draft = () => {
    setSaved(null)
    stream.reset()
    return run(async (signal) => {
      const course = ws.courses.get(courseId)
      const ctx = await ai.context(signal, course?.language, courseText(ws, courseId))
      const inputs = []
      for (const id of picked) {
        inputs.push({ photoId: id, image: await image(id), caption: getPhoto(ws, id)?.caption })
      }
      const out = await photoToCards(
        { ...ctx, onPartial: stream.onPartial },
        { photos: inputs, count: Number(count), courseTitle: course?.title },
      )
      const existing = ws.cards.list({ courseId }).map((c) => ws.text({ id: c.id, field: 'front' }).toString())
      const { kept, dropped } = dedupeDrafts(out, existing)
      const stamp = Date.now()
      return { drafts: kept.map((d, i) => ({ ...d, key: `${stamp}-${i}` })), dropped }
    })
  }

  const drafts = call.status === 'done' ? call.value.drafts : null
  const writing = call.status === 'busy' ? (stream.partial?.cards ?? []).filter((c) => c?.front) : []
  const setDrafts = (next: Draft[]) => {
    if (call.status === 'done') setCall({ status: 'done', value: { ...call.value, drafts: next } })
  }

  const save = () => {
    if (!drafts) return
    const keep = drafts.filter((d) => d.front.trim())
    ws.batch(() => {
      for (const d of keep) {
        // A card from a photo lands where its photo is, and cites it (a photo is a source).
        const from = getPhoto(ws, d.sourceRef?.sourceId ?? photoId) ?? getPhoto(ws, photoId)
        const place = from?.sectionId ? { sectionId: from.sectionId } : {}
        const id = ws.cards.create({ courseId, ...place, kind: d.kind, origin: 'ai', sourceId: from?.id })
        ws.text({ id, field: 'front' }).insert(0, d.front.trim())
        if (d.back.trim()) ws.text({ id, field: 'back' }).insert(0, d.back.trim())
      }
    })
    setSaved(keep.length)
    setCall(IDLE)
  }

  const cost = `${t('ai.cost', {
    amount: formatUsd(locale, estimatePhotoCardsCost(ai.info, picked.length, Number(count))),
  })} · ${ai.info.name}`

  return (
    <div className={styles.block}>
      <h3 className={styles.subtitle}>{t('photos.aiCards')}</h3>
      {others.length > 0 && <PhotoChoice photoId={photoId} others={others} chosen={picked} onChange={setChosen} />}
      <Segmented
        label={t('ai.cardCount')}
        value={count}
        onChange={setCount}
        options={COUNTS.map((c) => ({ value: c, label: c }))}
      />
      {call.status === 'busy' ? (
        <>
          <Busy label={t('photos.aiDrafting')} onCancel={cancel} />
          {writing.length > 0 && (
            <ol className={shared.list} aria-label={t('ai.drafts')} aria-busy="true">
              {streamedKeys(writing).map(({ item: c, key, last }) => (
                <li key={key} className={shared.card}>
                  <p className={shared.body}>{last && !c?.back ? `${c?.front ?? ''} ▍` : c?.front}</p>
                  {c?.back && <p className={shared.muted}>{last ? `${c.back} ▍` : c.back}</p>}
                </li>
              ))}
            </ol>
          )}
        </>
      ) : (
        <div className={shared.tight}>
          <div ref={actions} className={shared.row}>
            <Button variant={drafts ? 'secondary' : 'primary'} disabled={!online} onClick={draft}>
              {t('photos.aiDraft', { count: picked.length })}
            </Button>
          </div>
          <p className={shared.hint}>{cost}</p>
        </div>
      )}
      {call.status === 'failed' && <Failure call={call} ai={ai} />}
      {saved !== null && (
        <p ref={savedLine} tabIndex={-1} className={cx(shared.success, styles.quiet)} role="status">
          {t('ai.saved', { count: saved })} <Link href={to.place(courseId)}>{t('ai.openCourse')}</Link>
        </p>
      )}
      {drafts && call.status === 'done' && (
        <div ref={result} tabIndex={-1} className={styles.result}>
          <div className={shared.tight} role="status">
            <p className={shared.heading}>{t('ai.generated', { count: drafts.length })}</p>
            {call.value.dropped > 0 && (
              <p className={shared.hint}>{t('ai.duplicatesDropped', { count: call.value.dropped })}</p>
            )}
          </div>
          <ol className={shared.list} aria-label={t('ai.drafts')}>
            {drafts.map((d, i) => (
              <DraftEditor
                key={d.key}
                index={i + 1}
                draft={d}
                onChange={(p) => setDrafts(drafts.map((x) => (x.key === d.key ? { ...x, ...p } : x)))}
                onRemove={() => setDrafts(drafts.filter((x) => x.key !== d.key))}
              />
            ))}
          </ol>
          <div className={shared.row}>
            <Button variant="primary" onClick={save} disabled={drafts.length === 0}>
              {t('ai.saveCards', { count: drafts.length })}
            </Button>
            <Button
              variant="plain"
              onClick={() => {
                setCall(IDLE)
                actions.current?.querySelector('button')?.focus()
              }}
            >
              {t('ai.discard')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** This photo, plus any other photo of the course to draft from in the same request. */
function PhotoChoice({
  photoId,
  others,
  chosen,
  onChange,
}: {
  photoId: string
  others: readonly Photo[]
  chosen: readonly string[]
  onChange: (ids: string[]) => void
}) {
  const t = useT()
  const toggle = (id: string, on: boolean) => onChange(on ? [...chosen, id] : chosen.filter((x) => x !== id))
  const thumbs = useThumbs(others.map((p) => p.blobId))
  return (
    <fieldset className={shared.fieldset}>
      <legend className={shared.label}>{t('photos.aiPhotos')}</legend>
      <ul className={shared.checks}>
        <li>
          <label className={shared.check}>
            <input type="checkbox" checked disabled />
            <span>{t('photos.aiThisPhoto')}</span>
          </label>
        </li>
        {others.map((p) => (
          <li key={p.id}>
            <label className={shared.check}>
              <input type="checkbox" checked={chosen.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
              <PhotoThumb thumb={thumbs.get(p.blobId)} rotation={p.rotation} />
              <span>{photoLabel(p)}</span>
            </label>
          </li>
        ))}
      </ul>
      {chosen.length > 1 && chosen.includes(photoId) && (
        <p className={shared.hint}>{t('photos.aiPhotosHint', { count: chosen.length })}</p>
      )}
    </fieldset>
  )
}

/** A small preview telling photos with the same name apart; nothing while it is not ready. */
function PhotoThumb({ thumb, rotation }: { thumb: Thumb | undefined; rotation: Photo['rotation'] }) {
  if (thumb?.kind !== 'ready') return <span className={styles.thumb} aria-hidden="true" />
  return <img className={styles.thumb} src={thumb.url} alt="" data-rotation={rotation} />
}

function DraftEditor({
  draft,
  index,
  onChange,
  onRemove,
}: {
  draft: Draft
  index: number
  onChange: (p: Partial<CardDraft>) => void
  onRemove: () => void
}) {
  const t = useT()
  const id = useId()
  return (
    <li className={shared.card}>
      <div className={shared.row}>
        <span className={shared.badge}>{draft.kind === 'cloze' ? t('ai.kindCloze') : t('ai.kindBasic')}</span>
        <span className={shared.spacer} />
        <IconButton icon={Trash2} label={t('ai.removeDraft', { n: String(index) })} onClick={onRemove} />
      </div>
      <div className={shared.field}>
        <label className={shared.label} htmlFor={`${id}-f`}>
          {t('ai.front', { n: String(index) })}
        </label>
        <textarea
          id={`${id}-f`}
          className={shared.textarea}
          rows={2}
          value={draft.front}
          onChange={(e) => onChange({ front: e.target.value })}
        />
      </div>
      {draft.kind === 'basic' && (
        <div className={shared.field}>
          <label className={shared.label} htmlFor={`${id}-b`}>
            {t('ai.back', { n: String(index) })}
          </label>
          <textarea
            id={`${id}-b`}
            className={shared.textarea}
            rows={2}
            value={draft.back}
            onChange={(e) => onChange({ back: e.target.value })}
          />
        </div>
      )}
    </li>
  )
}
