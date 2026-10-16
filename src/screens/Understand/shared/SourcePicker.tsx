import { FileImage, FileText, NotebookText, Presentation, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { paths, to } from '../../../app/routes.ts'
import { useRuntime, useWorkspace, useWorkspaceData } from '../../../app/workspaceContext.tsx'
import type { Chunk } from '../../../core/ai/retrieval'
import type { SourceRef } from '../../../core/ai/schemas'
import type { StudyScope } from '../../../core/contracts/workspace'
import { blobStore } from '../../../core/log/blobs'
import { clozePlain } from '../../../core/model/cloze'
import { isPhoto, type Photo, photoLabel, toPhoto } from '../../../core/model/photos'
import type { SourceRecord } from '../../../core/model/schema'
import type { SectionTree } from '../../../core/model/sections'
import type { ModelWorkspace } from '../../../core/model/workspace'
import { useT } from '../../../i18n/react.tsx'
import { buttonClass } from '../../../ui/components/Button.tsx'
import { EmptyState } from '../../../ui/components/EmptyState.tsx'
import { useThumbs } from '../../Photos/files.ts'
import styles from './ai.module.css'
import type { MissingReason } from './aiConfig.ts'
import { citationText, useCitedUnit } from './citations.ts'
import { chunksFor, deckReader, PASTED } from './sources.ts'

export interface Selection {
  courseId: string
  /** A section of the course (its descendants included), or '' for the whole course. */
  sectionId: string
  sourceIds: string[]
  pasted: string
}

/** The selection a screen opens with: the course or section it was opened for, else the first course. */
export function selectionFor(scope: StudyScope | null): Selection {
  return scope === null
    ? emptySelection
    : { ...emptySelection, courseId: scope.courseId, sectionId: scope.sectionId ?? '' }
}

/** Indented "Contracts", "Contracts › Formation"… for the section menu, in tree order. */
function sectionOptions(tree: SectionTree, courseId: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = []
  const visit = (parentId: string | null, prefix: string) => {
    for (const s of tree.children(courseId, parentId)) {
      const label = prefix === '' ? s.name : `${prefix} › ${s.name}`
      out.push({ id: s.id, label })
      visit(s.id, label)
    }
  }
  visit(null, '')
  return out
}

const ICONS = { note: NotebookText, pdf: FileText, image: FileImage } as const
/** Slides and documents read unit by unit, whatever their file's `kind`. */
const iconOf = (s: SourceRecord) =>
  s.support === 'deck' ? Presentation : s.support === 'document' ? FileText : ICONS[s.kind]

/** The sources a selection can pick from: those of its course or section, descendants included. */
export function useScopedSources(value: Pick<Selection, 'courseId' | 'sectionId'>): readonly SourceRecord[] {
  return useWorkspaceData(['sources', 'sections', { id: `${value.courseId}/${value.sectionId}` }], (ws) =>
    value.courseId === ''
      ? []
      : ws.scoped(
          'sources',
          value.sectionId === ''
            ? { courseId: value.courseId }
            : { courseId: value.courseId, sectionId: value.sectionId },
        ),
  )
}

/**
 * Course, sources and optional pasted text an AI request is grounded in. Choosing a course or section checks all of
 * its sources; `chosen` keeps the sources of `value` as they are until then (a request run before, changed again).
 */
export function SourcePicker({
  value,
  onChange,
  chosen = false,
}: {
  value: Selection
  onChange: (s: Selection) => void
  chosen?: boolean
}) {
  const t = useT()
  const courseId = useId()
  const sectionId = useId()
  const pasteId = useId()
  const courses = useWorkspaceData(['courses'], (ws) => ws.courses.list())
  const tree = useWorkspaceData(['sections'], (ws) => ws.sections.tree())
  const sections = useMemo(() => sectionOptions(tree, value.courseId), [tree, value.courseId])
  const sources = useScopedSources(value)

  // Default to the first course, and to all of its sources.
  useEffect(() => {
    const first = courses[0]
    if (value.courseId === '' && first) onChange({ ...value, courseId: first.id })
  }, [courses, value, onChange])

  const seedKey = `${value.courseId}/${value.sectionId}`
  const [seeded, setSeeded] = useState(chosen ? seedKey : '')
  useEffect(() => {
    if (value.courseId && seeded !== seedKey) {
      setSeeded(seedKey)
      onChange({ ...value, sourceIds: sources.map((s) => s.id) })
    }
  }, [value, seeded, seedKey, sources, onChange])

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
            onChange={(e) => onChange({ courseId: e.target.value, sectionId: '', sourceIds: [], pasted: value.pasted })}
          >
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
      )}
      {sections.length > 0 && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={sectionId}>
            {t('ai.section')}
          </label>
          <select
            id={sectionId}
            className={styles.select}
            value={value.sectionId}
            onChange={(e) => onChange({ ...value, sectionId: e.target.value, sourceIds: [] })}
          >
            <option value="">{t('ai.wholeCourse')}</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
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
              const Icon = iconOf(s)
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

export const emptySelection: Selection = { courseId: '', sectionId: '', sourceIds: [], pasted: '' }

/** Loads the passages for a selection (PDF text and decks are read on demand). */
export function useChunkLoader(): (s: Selection) => Promise<Chunk[]> {
  const rt = useRuntime()
  const ws = useWorkspace()
  const blobs = useMemo(() => blobStore(rt.store), [rt])
  const readDeck = useMemo(() => deckReader(rt), [rt])
  return useCallback((s: Selection) => chunksFor(ws, blobs, s.sourceIds, s.pasted, readDeck), [ws, blobs, readDeck])
}

const MISSING_BODY = {
  none: 'ai.noKey',
  noKey: 'ai.missingKey',
  notDownloaded: 'ai.missingDownload',
  moved: 'ai.missingMoved',
} as const

/** Shown instead of an AI screen until a model is set up, saying what is missing. */
export function NoModel({ reason = 'none' }: { reason?: MissingReason }) {
  const t = useT()
  return (
    <EmptyState
      icon={Sparkles}
      title={t('common.aiEmptyTitle')}
      body={t(MISSING_BODY[reason])}
      action={
        <Link href={paths.settingsAi} className={buttonClass({ variant: 'primary' })}>
          {t('ai.openSettings')}
        </Link>
      }
    />
  )
}

/** A citation: links to the cited source (and page, slide or section) when it is a saved source. */
export function Citation({ sourceRef }: { sourceRef: SourceRef }) {
  const t = useT()
  const source = useWorkspaceData([{ id: sourceRef.sourceId }], (ws) => ws.sources.get(sourceRef.sourceId))
  const unit = useCitedUnit(source, sourceRef.page)
  // The chat also cites what the student wrote: a card, a study sheet.
  const written = useWorkspaceData([{ id: sourceRef.sourceId }], (ws) => writtenCitation(ws, sourceRef.sourceId))
  const label = sourceRef.sourceId === PASTED ? t('ai.pastedSource') : (source?.title ?? t('ai.unknownSource'))
  const text = citationText(t, label, source, sourceRef.page, unit)
  if (!source && written) {
    const name = written.kind === 'card' ? t('ai.citedCard', { front: written.name }) : written.name
    return (
      <Link href={written.href} className={styles.cite} aria-label={t('ai.openCitation', { source: name })}>
        {name}
      </Link>
    )
  }
  if (!source) return <span className={styles.cite}>{text}</span>
  if (isPhoto(source)) return <PhotoCitation photo={toPhoto(source)} />
  const href = sourceRef.page === undefined ? to.source(source.id) : `${to.source(source.id)}?page=${sourceRef.page}`
  return (
    <Link href={href} className={styles.cite} aria-label={t('ai.openCitation', { source: text })}>
      {text}
    </Link>
  )
}

/** Longest card question shown in a citation. */
const CITED_FRONT_CHARS = 60

/** A cited card (its question) or study sheet (its title), live; null for anything else. */
function writtenCitation(
  ws: ModelWorkspace,
  id: string,
): { kind: 'card' | 'sheet'; name: string; href: string } | null {
  const card = ws.cards.get(id)
  if (card && card.deletedAt === undefined) {
    const front = clozePlain(ws.text({ id, field: 'front' }).toString())
      .trim()
      .replace(/\s+/g, ' ')
    const name = front.length > CITED_FRONT_CHARS ? `${front.slice(0, CITED_FRONT_CHARS)}…` : front
    return { kind: 'card', name, href: to.card(id) }
  }
  const sheet = ws.fiches.get(id)
  if (sheet && sheet.deletedAt === undefined) return { kind: 'sheet', name: sheet.title, href: to.fiche(id) }
  return null
}

/** A cited photo: its thumbnail and name, opening the photo viewer. */
function PhotoCitation({ photo }: { photo: Photo }) {
  const t = useT()
  const thumb = useThumbs([photo.blobId]).get(photo.blobId)
  const name = photoLabel(photo)
  return (
    <Link href={to.photo(photo.id)} className={styles.cite} aria-label={t('photos.aiOpenPhoto', { name })}>
      {thumb?.kind === 'ready' && (
        <img className={styles.citeThumb} src={thumb.url} alt="" data-rotation={photo.rotation} />
      )}
      {name}
    </Link>
  )
}
