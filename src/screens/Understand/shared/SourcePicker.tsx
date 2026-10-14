import { FileImage, FileText, NotebookText, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { paths, to } from '../../../app/routes.ts'
import { useRuntime, useWorkspace, useWorkspaceData } from '../../../app/workspaceContext.tsx'
import type { Chunk } from '../../../core/ai/retrieval'
import type { SourceRef } from '../../../core/ai/schemas'
import { blobStore } from '../../../core/log/blobs'
import { useT } from '../../../i18n/react.tsx'
import { buttonClass } from '../../../ui/components/Button.tsx'
import { EmptyState } from '../../../ui/components/EmptyState.tsx'
import styles from './ai.module.css'
import { chunksFor, PASTED } from './sources.ts'

export interface Selection {
  courseId: string
  sourceIds: string[]
  pasted: string
}

const ICONS = { note: NotebookText, pdf: FileText, image: FileImage } as const

/** Course, sources and optional pasted text an AI request is grounded in. */
export function SourcePicker({ value, onChange }: { value: Selection; onChange: (s: Selection) => void }) {
  const t = useT()
  const courseId = useId()
  const pasteId = useId()
  const courses = useWorkspaceData(['courses'], (ws) => ws.courses.list())
  const allSources = useWorkspaceData(['sources'], (ws) => ws.sources.list())
  const sources = useMemo(() => allSources.filter((s) => s.courseId === value.courseId), [allSources, value.courseId])

  // Default to the first course, and to all of its sources.
  useEffect(() => {
    const first = courses[0]
    if (value.courseId === '' && first) onChange({ ...value, courseId: first.id })
  }, [courses, value, onChange])

  const [seeded, setSeeded] = useState('')
  useEffect(() => {
    if (value.courseId && seeded !== value.courseId) {
      setSeeded(value.courseId)
      onChange({ ...value, sourceIds: sources.map((s) => s.id) })
    }
  }, [value, seeded, sources, onChange])

  const toggle = (id: string, on: boolean) =>
    onChange({ ...value, sourceIds: on ? [...value.sourceIds, id] : value.sourceIds.filter((x) => x !== id) })

  return (
    <div className={styles.stack}>
      {courses.length > 0 && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={courseId}>
            {t('ai.course')}
          </label>
          <select
            id={courseId}
            className={styles.select}
            value={value.courseId}
            onChange={(e) => onChange({ courseId: e.target.value, sourceIds: [], pasted: value.pasted })}
          >
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
      )}
      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>{t('ai.sourcesLabel')}</legend>
        {sources.length === 0 ? (
          <p className={styles.hint}>{t('ai.noSources')}</p>
        ) : (
          <ul className={styles.checks}>
            {sources.map((s) => {
              const Icon = ICONS[s.kind]
              return (
                <li key={s.id}>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={value.sourceIds.includes(s.id)}
                      onChange={(e) => toggle(s.id, e.target.checked)}
                    />
                    <Icon size={18} aria-hidden="true" className={styles.checkIcon} />
                    <span>{s.title}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </fieldset>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={pasteId}>
          {t('ai.pasteLabel')}
        </label>
        <textarea
          id={pasteId}
          className={styles.textarea}
          rows={4}
          value={value.pasted}
          placeholder={t('ai.pastePlaceholder')}
          onChange={(e) => onChange({ ...value, pasted: e.target.value })}
        />
      </div>
    </div>
  )
}

export const emptySelection: Selection = { courseId: '', sourceIds: [], pasted: '' }

/** Loads the passages for a selection (PDF text is extracted on demand). */
export function useChunkLoader(): (s: Selection) => Promise<Chunk[]> {
  const rt = useRuntime()
  const ws = useWorkspace()
  const blobs = useMemo(() => blobStore(rt.store), [rt])
  return useCallback((s: Selection) => chunksFor(ws, blobs, s.sourceIds, s.pasted), [ws, blobs])
}

/** Shown instead of an AI screen until a model and key are set up. */
export function NoModel() {
  const t = useT()
  return (
    <EmptyState
      icon={Sparkles}
      title={t('common.aiEmptyTitle')}
      body={t('ai.noKey')}
      action={
        <Link href={paths.settingsAi} className={buttonClass({ variant: 'primary' })}>
          {t('ai.openSettings')}
        </Link>
      }
    />
  )
}

/** A citation: links to the cited source (and page) when it is a saved source. */
export function Citation({ sourceRef }: { sourceRef: SourceRef }) {
  const t = useT()
  const source = useWorkspaceData([{ id: sourceRef.sourceId }], (ws) => ws.sources.get(sourceRef.sourceId))
  const label = sourceRef.sourceId === PASTED ? t('ai.pastedSource') : (source?.title ?? t('ai.unknownSource'))
  const text = sourceRef.page === undefined ? label : t('ai.citePage', { source: label, page: sourceRef.page })
  if (!source) return <span className={styles.cite}>{text}</span>
  const href = sourceRef.page === undefined ? to.source(source.id) : `${to.source(source.id)}?page=${sourceRef.page}`
  return (
    <Link href={href} className={styles.cite} aria-label={t('ai.openCitation', { source: text })}>
      {text}
    </Link>
  )
}
