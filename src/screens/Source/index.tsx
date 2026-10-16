import { BookOpen, ExternalLink, FolderInput, History, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation, useParams, useSearch } from 'wouter'
import { backHome, leaveTo } from '../../app/nav.ts'
import { to } from '../../app/routes.ts'
import { useSync } from '../../app/syncContext.tsx'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { SourceRecord } from '../../core/model/schema'
import { useT } from '../../i18n/react.tsx'
import { useAiReady } from '../../ui/ai/ready.ts'
import { useChatContext } from '../../ui/chat/context.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { AskSelection } from '../../ui/ExplainLauncher.tsx'
import { MarkdownEditor } from '../../ui/editor/MarkdownEditor.tsx'
import { MoveSheet, moveItemTo } from '../../ui/MoveSheet.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { deckErrorMessage } from '../DeckImport/deckSource.ts'
import { Generate } from '../Generate/open.tsx'
import NotFound from '../NotFound/index.tsx'
import AttachedPhotos from '../Photos/Attached.tsx'
import { loadFile } from '../Photos/files.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { isReadable, notesWritten } from '../Understand/shared/readable.ts'
import { DeckView } from './DeckView.tsx'
import { readPdfInApp } from './importers.ts'
import { Proposals } from './Proposals.tsx'
import styles from './Source.module.css'

type FileState =
  | { phase: 'loading' }
  | { phase: 'fetching' }
  | { phase: 'missing' }
  | { phase: 'ready'; url: string; size: number }

/**
 * Object URL of a source's stored file, revoked when the screen leaves. A file not on this device yet (a photo
 * kept "on demand", or not synced down yet) is downloaded from a destination when the source opens.
 */
function useSourceFile(blobId: string | undefined): FileState {
  const rt = useRuntime()
  const { engine } = useSync()
  const [state, setState] = useState<FileState>({ phase: 'loading' })
  useEffect(() => {
    if (blobId === undefined) {
      setState({ phase: 'missing' })
      return
    }
    let live = true
    let url: string | null = null
    setState({ phase: 'loading' })
    loadFile(rt, null, blobId)
      .then((local) => {
        if (local !== null || engine === null) return local
        if (live) setState({ phase: 'fetching' })
        return loadFile(rt, engine, blobId)
      })
      .then(
        (blob) => {
          if (!live) return
          if (blob === null) return setState({ phase: 'missing' })
          url = URL.createObjectURL(blob)
          setState({ phase: 'ready', url, size: blob.size })
        },
        (e: unknown) => {
          noteError('source.file', e)
          if (live) setState({ phase: 'missing' })
        },
      )
    return () => {
      live = false
      if (url !== null) URL.revokeObjectURL(url)
    }
  }, [rt, engine, blobId])
  return state
}

/** `?page=N` from a citation, if any. */
function citedPage(search: string): number | undefined {
  const n = Number(new URLSearchParams(search).get('page'))
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** « Read this PDF in the app »: a PDF kept as a mere file becomes pages, in place. */
function ReadInApp({ source }: { source: SourceRecord }) {
  const t = useT()
  const rt = useRuntime()
  const aiReady = useAiReady()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const read = () => {
    setBusy(true)
    setError(null)
    readPdfInApp(rt, source).then(
      () => setBusy(false),
      (e: unknown) => {
        noteError('source.readPdf', e)
        setBusy(false)
        setError(deckErrorMessage(t, e))
      },
    )
  }
  return (
    <>
      <p className={styles.note}>{aiReady ? t('course.readPdfHint') : t('course.readPdfHintNoAi')}</p>
      <Button variant="primary" icon={<BookOpen size={18} aria-hidden="true" />} loading={busy} onClick={read}>
        {t('course.readPdfInApp')}
      </Button>
      {error !== null && (
        <p className={styles.note} role="alert">
          {error}
        </p>
      )}
    </>
  )
}

/** The original of a slide deck or a document read in the app, to open in the system viewer. */
function Original({ source, page }: { source: SourceRecord; page: number | undefined }) {
  const t = useT()
  const file = useSourceFile(source.blobId)
  if (file.phase !== 'ready') return null
  // PDF open parameters: the system viewer starts at the cited page.
  const pdf = source.kind === 'pdf'
  return (
    <div className={styles.actions}>
      <a
        className={buttonClass({ variant: 'plain' })}
        href={pdf && page !== undefined ? `${file.url}#page=${page}` : file.url}
        target="_blank"
        rel="noopener"
        {...(pdf ? { type: 'application/pdf' } : { download: source.title })}
      >
        <ExternalLink size={18} aria-hidden="true" />
        {t('course.openOriginal')}
      </a>
    </div>
  )
}

function Attachment({ source, page }: { source: SourceRecord; page: number | undefined }) {
  const t = useT()
  const file = useSourceFile(source.blobId)
  if (file.phase === 'loading') return <p className={styles.note}>{t('common.loading')}</p>
  if (file.phase === 'fetching')
    return (
      <p className={styles.note} role="status">
        {source.kind === 'image' ? t('photos.downloading') : t('ai.sourceDownloading')}
      </p>
    )
  if (file.phase === 'missing') return <p className={styles.note}>{t('course.fileMissing')}</p>
  if (source.kind === 'image') {
    return <img className={styles.photo} src={file.url} alt={source.title} />
  }
  return (
    <div className={styles.pdf}>
      <p className={styles.note}>{page === undefined ? t('course.pdfHint') : t('course.pdfCitedPage', { page })}</p>
      {/* The system viewer opens the PDF: Preview on the Mac, Quick Look on iPad. */}
      <a
        className={buttonClass({ variant: 'primary' })}
        // PDF open parameters: the system viewer starts at the cited page.
        href={page === undefined ? file.url : `${file.url}#page=${page}`}
        target="_blank"
        rel="noopener"
        type="application/pdf"
      >
        <ExternalLink size={18} aria-hidden="true" />
        {t('course.openPdf')}
      </a>
      <ReadInApp source={source} />
    </div>
  )
}

/**
 * Whether a model has anything to read in the source (`isReadable`); for a photo, a reading kept on this device
 * counts too, looked up when it opens.
 */
function useReadable(source: SourceRecord | undefined): boolean {
  const rt = useRuntime()
  const id = source?.id ?? ''
  const notes = useWorkspaceData([{ id }], (w) => w.sources.get(id) !== undefined && notesWritten(w, id))
  const image = source?.kind === 'image'
  const [read, setRead] = useState<string | null>(null)
  useEffect(() => {
    if (!image) return
    let live = true
    import('../../core/ai/features/describePhoto')
      .then(({ loadReadings }) => loadReadings(rt.store, [id]))
      .then(
        (found) => {
          if (live && found.length > 0) setRead(id)
        },
        (e: unknown) => console.warn('the photo reading could not be looked up', e),
      )
    return () => {
      live = false
    }
  }, [rt, id, image])
  return source !== undefined && isReadable(source, { notes, read: read === id })
}

export default function Source() {
  const t = useT()
  const rt = useRuntime()
  const { id = '' } = useParams<{ id: string }>()
  const search = useSearch()
  // The cited page is read once per source; it stays in this entry's hash only, so later links don't inherit it.
  const [cited, setCited] = useState(() => ({ id, page: citedPage(search) }))
  if (cited.id !== id) setCited({ id, page: citedPage(search) })
  const page = cited.page
  const [moving, setMoving] = useState(false)
  const [movedTo, setMovedTo] = useState<string | null>(null)
  const found = useWorkspaceData(['sources', 'sections'], (w) => {
    const s = w.sources.get(id)
    return s && s.deletedAt === undefined ? { source: s, sectionId: w.sections.tree().sectionOf(s) } : null
  })
  const readable = useReadable(found?.source)
  // « Create cards » on this source (`?generate=1`: its buttons, an import, an old link), with a model only.
  const aiReady = useAiReady()
  const [, navigate] = useLocation()
  const generating = aiReady && new URLSearchParams(search).get('generate') === '1'
  useChatContext(
    found === null
      ? {}
      : {
          courseId: found.source.courseId,
          sourceId: found.source.id,
          ...(found.sectionId === null ? {} : { sectionId: found.sectionId }),
        },
  )
  if (found === null) return <NotFound />
  const { source, sectionId } = found
  const home = to.place(source.courseId, sectionId)
  const notes = rt.ws.text({ id: source.id, field: 'body' })
  // Photos added from the editor are kept with the source's own.
  const photos = { courseId: source.courseId, ...(sectionId === null ? {} : { sectionId }) }
  const remove = () => {
    rt.ws.sources.trash(source.id)
    leaveTo(home)
  }
  return (
    <Screen title={source.title} back={home} backOptions={backHome(home)}>
      {source.support === undefined ? (
        <>
          {source.kind !== 'note' && <Attachment source={source} page={page} />}
          <MarkdownEditor
            text={notes}
            label={source.kind === 'note' ? t('common.sourceTitle') : t('course.sourceNotes')}
            placeholder={source.kind === 'note' ? t('common.sourceEmpty') : t('course.notesEmpty')}
            photos={photos}
          />
        </>
      ) : (
        <>
          {/* Slides or a document: its content first, read unit by unit, cited as « slide 12 », « page 7 ». */}
          <DeckView source={source} cited={page} />
          <Original source={source} page={page} />
          <details className={styles.notes} open={notes.length > 0}>
            <summary className={styles.notesTitle}>{t('course.myNotes')}</summary>
            <MarkdownEditor
              text={notes}
              label={t('course.sourceNotes')}
              placeholder={t('course.notesEmpty')}
              photos={photos}
            />
          </details>
        </>
      )}
      <AskSelection />
      {source.kind !== 'image' && <AttachedPhotos sourceId={source.id} />}
      <Proposals sourceId={source.id} readable={readable} />
      <div className={styles.actions}>
        <Link href={to.history(source.id)} className={buttonClass({ variant: 'plain' })}>
          <History size={18} aria-hidden="true" />
          {t('course.history')}
        </Link>
        <Button variant="plain" icon={<FolderInput size={18} aria-hidden="true" />} onClick={() => setMoving(true)}>
          {t('course.moveTo')}
        </Button>
        <Button variant="danger" icon={<Trash2 size={18} aria-hidden="true" />} onClick={remove}>
          {t('course.moveToTrash')}
        </Button>
      </div>
      {movedTo !== null && (
        <p className={styles.note} role="status">
          {t('course.moved', { place: movedTo })}
        </p>
      )}
      <Generate
        at={generating ? { sourceIds: [source.id] } : null}
        onClose={() => navigate(to.source(id), { replace: true })}
      />
      <MoveSheet
        open={moving}
        title={t('course.moveTitle')}
        onClose={() => setMoving(false)}
        current={{ courseId: source.courseId, sectionId }}
        onMove={(place) => moveItemTo(rt.ws, 'sources', source.id, place)}
        onMoved={setMovedTo}
      />
    </Screen>
  )
}
