import { FolderInput, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useParams, useSearch } from 'wouter'
import { backHome, leaveTo } from '../../app/nav.ts'
import { to } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { StudyScope } from '../../core/contracts/workspace'
import { useT } from '../../i18n/react.tsx'
import { useAiReady } from '../../ui/ai/ready.ts'
import { useChatContext } from '../../ui/chat/context.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { AskSelection } from '../../ui/ExplainLauncher.tsx'
import type { EditorWriter } from '../../ui/editor/aiWrite.ts'
import { MarkdownEditor } from '../../ui/editor/MarkdownEditor.tsx'
import { MoveSheet, moveItemTo } from '../../ui/MoveSheet.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import NotFound from '../NotFound/index.tsx'
import { WRITE_QUERY } from './create.ts'
import styles from './Fiche.module.css'
import { WritePanel } from './WritePanel.tsx'

/**
 * A study sheet: its title and its text, written by hand in the editor or by AI into it (« Write with AI »), a term
 * selected in it asked about in the chat, moved or put in the trash. Opened with `?write=1`, the AI writes it at once.
 */
export default function Fiche() {
  const t = useT()
  const rt = useRuntime()
  const ws = rt.ws
  const { id = '' } = useParams<{ id: string }>()
  const [, navigate] = useLocation()
  const search = useSearch()
  const aiReady = useAiReady()
  // Read once: the query belongs to the visit that asked for it, a reload never writes the sheet again.
  const [autostart] = useState(() => new URLSearchParams(search).get('write') === WRITE_QUERY.split('=')[1])
  useEffect(() => {
    if (autostart) navigate(to.fiche(id), { replace: true })
  }, [autostart, id, navigate])
  const [writer, setWriter] = useState<EditorWriter | null>(null)
  const [moving, setMoving] = useState(false)
  const [movedTo, setMovedTo] = useState<string | null>(null)
  const found = useWorkspaceData(['fiches', 'sections', { id }], (w) => {
    const f = w.fiches.get(id)
    return f && f.deletedAt === undefined ? { fiche: f, sectionId: w.sections.tree().sectionOf(f) } : null
  })
  useChatContext(
    found === null
      ? {}
      : { courseId: found.fiche.courseId, ...(found.sectionId === null ? {} : { sectionId: found.sectionId }) },
  )
  const [title, setTitle] = useState(found?.fiche.title ?? '')
  const savedTitle = found?.fiche.title
  // Renamed elsewhere (or by the AI writing it): the field follows while it is not being changed here.
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing && savedTitle !== undefined) setTitle(savedTitle)
  }, [editing, savedTitle])
  if (found === null) return <NotFound />
  const { fiche, sectionId } = found
  const place: StudyScope = sectionId === null ? { courseId: fiche.courseId } : { courseId: fiche.courseId, sectionId }
  const home = to.place(fiche.courseId, sectionId)
  const body = ws.text({ id: fiche.id, field: 'body' })
  const rename = () => {
    setEditing(false)
    const name = title.trim()
    if (name === '' || name === fiche.title) setTitle(fiche.title)
    else ws.fiches.update(fiche.id, { title: name })
  }
  const remove = () => {
    ws.fiches.trash(fiche.id)
    leaveTo(home)
  }
  return (
    <Screen title={fiche.title} back={home} backOptions={backHome(home)}>
      <div className={styles.stack}>
        <Field
          label={t('course.sheetTitle')}
          value={title}
          onFocus={() => setEditing(true)}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          autoComplete="off"
        />
        <MarkdownEditor
          text={body}
          label={t('ai.fiche')}
          placeholder={t('course.sheetPlaceholder')}
          photos={place}
          writer={setWriter}
        />
        <AskSelection />
        {aiReady && (
          <WritePanel
            fiche={fiche}
            place={place}
            writer={writer}
            untitled={fiche.title === t('course.untitledSheet')}
            autostart={autostart}
          />
        )}
        <div className={styles.actions}>
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
      </div>
      <MoveSheet
        open={moving}
        title={t('course.moveTitle')}
        onClose={() => setMoving(false)}
        current={{ courseId: fiche.courseId, sectionId }}
        onMove={(p) => moveItemTo(ws, 'fiches', fiche.id, p)}
        onMoved={setMovedTo}
      />
    </Screen>
  )
}
