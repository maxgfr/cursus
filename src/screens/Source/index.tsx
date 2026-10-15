import { ExternalLink, FolderInput, History, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation, useParams, useSearch } from 'wouter'
import { to } from '../../app/routes.ts'
import { useSync } from '../../app/syncContext.tsx'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { SourceRecord } from '../../core/model/schema'
import { useT } from '../../i18n/react.tsx'
import { useChatContext } from '../../ui/chat/context.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { leftNote } from '../../ui/data/autoQuestions.ts'
import { ExplainSelection } from '../../ui/ExplainLauncher.tsx'
import { MarkdownEditor } from '../../ui/editor/MarkdownEditor.tsx'
import { MoveSheet, moveItemTo } from '../../ui/MoveSheet.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import NotFound from '../NotFound/index.tsx'
import AttachedPhotos from '../Photos/Attached.tsx'
import { loadFile } from '../Photos/files.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { DeckView } from './DeckView.tsx'
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
    </div>
  )
}

export default function Source() {
  const t = useT()
  const rt = useRuntime()
  const [, navigate] = useLocation()
  const { id = '' } = useParams<{ id: string }>()
  const search = useSearch()
  // The cited page is read once per source, then dropped from the URL so later links don't inherit it.
  const [cited, setCited] = useState(() => ({ id, page: citedPage(search) }))
  if (cited.id !== id) setCited({ id, page: citedPage(search) })
  const page = cited.page
  useEffect(() => {
    if (search === '') return
    const url = new URL(window.location.href)
    url.search = ''
    window.history.replaceState(window.history.state, '', url.href)
  }, [search])
  const [moving, setMoving] = useState(false)
  const [movedTo, setMovedTo] = useState<string | null>(null)
  // A note written here for the first time gets its questions proposed when the student leaves it.
  useEffect(() => () => leftNote(rt, id), [rt, id])
  const found = useWorkspaceData(['sources', 'sections'], (w) => {
    const s = w.sources.get(id)
    return s && s.deletedAt === undefined ? { source: s, sectionId: w.sections.tree().sectionOf(s) } : null
  })
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
  const remove = () => {
    rt.ws.sources.trash(source.id)
    navigate(home)
  }
  return (
    <Screen title={source.title} back={home}>
      {source.kind !== 'note' && <Attachment source={source} page={page} />}
      {/* Slides or a structured document: read unit by unit, cited as « slide 12 », « section 2.3 ». */}
      {source.support !== undefined && <DeckView source={source} cited={page} />}
      <MarkdownEditor
        text={rt.ws.text({ id: source.id, field: 'body' })}
        label={
          source.kind === 'note' && source.support === undefined ? t('common.sourceTitle') : t('course.sourceNotes')
        }
        placeholder={t('common.sourceEmpty')}
      />
      <ExplainSelection courseId={source.courseId} sectionId={sectionId ?? undefined} />
      {source.kind !== 'image' && <AttachedPhotos sourceId={source.id} />}
      <Proposals sourceId={source.id} />
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
