import { FileUp } from 'lucide-react'
import { type ChangeEvent, type FormEvent, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { to } from '../../app/routes.ts'
import { useRuntime } from '../../app/workspaceContext.tsx'
import type { Id } from '../../core/contracts/workspace'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { proposeFor } from '../../ui/data/autoQuestions.ts'
import { deckErrorMessage } from '../DeckImport/deckSource.ts'
import { addFile, FILES_ACCEPT, fileTitle } from '../Source/importers.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './Today.module.css'

/**
 * Creates a course on an explicit action only (nothing is ever seeded). « From files » takes one or more files,
 * proposes a name from the first one, then adds each file as a source and opens the course on its sources.
 */
export function NewCourseSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const rt = useRuntime()
  const [, navigate] = useLocation()
  const [title, setTitle] = useState('')
  const [files, setFiles] = useState<readonly File[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<{ courseId: Id; message: string } | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const reset = () => {
    setTitle('')
    setFiles([])
    setFailed(null)
  }
  const close = () => {
    if (busy) return
    reset()
    onClose()
  }
  const openCourse = (id: Id) => {
    reset()
    onClose()
    navigate(to.course(id))
  }

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.currentTarget.files ?? [])
    e.currentTarget.value = ''
    const first = picked[0]
    if (first === undefined) return
    setFiles(picked)
    setFailed(null)
    // A name is proposed only while the field is empty: never over what the student typed.
    if (title.trim() === '') void fileTitle(first).then((name) => setTitle((now) => (now.trim() === '' ? name : now)))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const name = title.trim()
    if (name === '' || busy) return
    const id = rt.ws.courses.create({ title: name })
    if (files.length === 0) return openCourse(id)
    setBusy(true)
    const fallback = {
      note: t('course.untitledNote'),
      photo: t('course.untitledPhoto'),
      pdf: t('course.untitledPdf'),
      deck: t('ai.deckUntitled'),
    }
    const errors: string[] = []
    for (const file of files) {
      try {
        void proposeFor(rt, await addFile(rt, id, file, fallback))
      } catch (err) {
        noteError('course.newFromFiles', err)
        errors.push(t('course.fileFailed', { name: file.name, reason: deckErrorMessage(t, err) }))
      }
    }
    setBusy(false)
    if (errors.length === 0) openCourse(id)
    else setFailed({ courseId: id, message: errors.join(' ') })
  }

  return (
    <Sheet open={open} title={t('today.addCourse')} onClose={close}>
      <form onSubmit={(e) => void submit(e)} className={styles.form}>
        <Field
          label={t('course.name')}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          enterKeyHint="done"
          autoComplete="off"
          required
          hint={files.length > 0 ? t('today.fromFilesNameHint') : undefined}
        />
        <div className={styles.fromFiles}>
          <Button
            variant="plain"
            icon={<FileUp size={18} aria-hidden="true" />}
            onClick={() => input.current?.click()}
            disabled={busy || failed !== null}
          >
            {t('today.fromFiles')}
          </Button>
          <input
            ref={input}
            className="sr-only"
            type="file"
            multiple
            accept={FILES_ACCEPT}
            aria-label={t('today.fromFiles')}
            tabIndex={-1}
            onChange={onPick}
          />
          {files.length > 0 && (
            <p className={styles.fromFilesList} role="status">
              {t('today.filesChosen', { count: files.length, names: files.map((f) => f.name).join(', ') })}
            </p>
          )}
        </div>
        {busy && (
          <p className={styles.fromFilesList} role="status">
            {t('today.importingFiles')}
          </p>
        )}
        {failed === null ? (
          <Button type="submit" variant="primary" size="large" full loading={busy} disabled={title.trim() === ''}>
            {t('common.save')}
          </Button>
        ) : (
          <>
            <p className={styles.fromFilesList} role="alert">
              {failed.message}
            </p>
            <Button variant="primary" size="large" full onClick={() => openCourse(failed.courseId)}>
              {t('today.openNewCourse')}
            </Button>
          </>
        )}
      </form>
    </Sheet>
  )
}
