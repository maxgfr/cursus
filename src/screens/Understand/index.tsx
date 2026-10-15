import { ChevronDown, Library, NotebookText, RotateCcw } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'wouter'
import { readEntry, writeEntry } from '../../app/nav.ts'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { readingChunks } from '../../core/ai/features/describePhoto'
import { explainBack } from '../../core/ai/features/explainBack'
import { type Chunk, isValidRef } from '../../core/ai/retrieval'
import type { ExplainBackReview, SourceRef, Understanding } from '../../core/ai/schemas'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { useChatContext } from '../../ui/chat/context.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { usePartial } from '../../ui/data/usePartial.ts'
import { AskSelection } from '../../ui/ExplainLauncher.tsx'
import { Sanitized } from '../../ui/render/Sanitized.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import type { CardNotice } from '../Course/View.tsx'
import { useScopeOnce } from '../Section/scope.ts'
import styles from './shared/ai.module.css'
import { passagesText, useAiModel } from './shared/aiConfig.ts'
import {
  Citation,
  NoModel,
  type Selection,
  SourcePicker,
  selectionFor,
  useChunkLoader,
  useScopedSources,
} from './shared/SourcePicker.tsx'
import { estimateCost } from './shared/sources.ts'
import { type Detail, streamUnderstanding } from './stream.ts'

type Point = { heading?: string; explanation?: string; sourceRef?: Partial<SourceRef> }
type Draft = { title?: string; summary?: string; points?: (Point | undefined)[] }

/** The last explanation, kept in this screen's history entry. */
const KEPT = 'cursusUnderstand'
type Kept = { topic: string; detail: Detail; done: Understanding; grounded: Chunk[] }

type T = ReturnType<typeof useT>

/** « New study sheet »: the AI writes one on a topic from the course's sources, read as the sheet it will be. */
export default function Understand() {
  const t = useT()
  const locale = useLocale()
  const ws = useWorkspace()
  const ai = useAiModel()
  const loadChunks = useChunkLoader()
  const opened = useScopeOnce()
  // Back to the course or section it was opened from, else to the courses.
  const back = opened ? to.place(opened.courseId, opened.sectionId) : paths.courses
  const [selection, setSelection] = useState<Selection>(() => selectionFor(opened))
  // The sheet stays with this screen's history entry: back from a cited photo or source, it is still there.
  const [kept] = useState(() => readEntry<Kept>(KEPT))
  const [topic, setTopic] = useState(kept?.topic ?? '')
  const [detail, setDetail] = useState<Detail>(kept?.detail ?? 'standard')
  const [estimate, setEstimate] = useState<number | null>(null)
  const [sheet, setSheet] = useState<Draft | null>(kept?.done ?? null)
  const [done, setDone] = useState<Understanding | null>(kept?.done ?? null)
  const [grounded, setGrounded] = useState<Chunk[]>(kept?.grounded ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)
  const topicId = useId()
  const place = usePlaceName(selection)
  const scoped = useScopedSources(selection)

  const onSelection = useCallback((s: Selection) => setSelection(s), [])
  useChatContext({
    ...(selection.courseId ? { courseId: selection.courseId } : {}),
    ...(selection.sectionId ? { sectionId: selection.sectionId } : {}),
  })
  const rt = useRuntime()
  const [photosRead, setPhotosRead] = useState(0)
  // A chosen photo grounds the request (and is cited) through what a vision model read on it, kept on this device.
  const loadAll = useCallback(
    async (s: Selection): Promise<Chunk[]> => {
      const photoIds = s.sourceIds.filter((id) => ws.sources.get(id)?.kind === 'image')
      const [chunks, read] = await Promise.all([loadChunks(s), readingChunks(rt.store, photoIds)])
      return [...chunks, ...read]
    },
    [loadChunks, ws, rt],
  )

  // Estimated cost of the next request, refreshed as the selection changes.
  useEffect(() => {
    if (ai.status !== 'ready') return
    let live = true
    loadAll(selection).then(
      (chunks) => {
        if (!live) return
        setEstimate(estimateCost(ai.info, chunks))
        setPhotosRead(
          new Set(chunks.filter((c) => ws.sources.get(c.sourceId)?.kind === 'image').map((c) => c.sourceId)).size,
        )
      },
      () => {
        if (live) setEstimate(null)
      },
    )
    return () => {
      live = false
    }
  }, [ai, selection, loadAll, ws])

  useEffect(() => () => abort.current?.abort(), [])

  const title = t('course.newSheet')
  if (ai.status === 'loading') return <Screen title={title} back={back} />
  if (ai.status === 'missing')
    return (
      <Screen title={title} back={back}>
        <NoModel reason={ai.reason} />
      </Screen>
    )

  const courseLanguage = ws.courses.get(selection.courseId)?.language

  /** Writes the sheet, streamed in as it comes; « Rewrite » runs it again with what the composer holds. */
  const write = async () => {
    if (!topic.trim()) return
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setBusy(true)
    setError('')
    setSheet(null)
    setDone(null)
    try {
      const chunks = await loadAll(selection)
      const ctx = await ai.context(ctl.signal, courseLanguage, passagesText(chunks))
      const s = streamUnderstanding(ctx, { topic: topic.trim(), detail, chunks })
      setGrounded(s.grounded)
      for await (const part of s.partial) setSheet(part)
      const out = await s.output
      setSheet(out)
      setDone(out)
      const keep: Kept = { topic: topic.trim(), detail, done: out, grounded: s.grounded }
      // Left meanwhile (aborted): the entry showing now is another screen's.
      if (!ctl.signal.aborted) writeEntry(KEPT, keep)
    } catch (err) {
      if (!ctl.signal.aborted) setError(t('ai.failed', { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void write()
  }

  const validRef = (r: Partial<SourceRef> | undefined): SourceRef | null =>
    r?.sourceId && isValidRef({ sourceId: r.sourceId, page: r.page }, grounded)
      ? { sourceId: r.sourceId, page: r.page }
      : null

  const chosen = scoped.filter((s) => selection.sourceIds.includes(s.id)).length
  const used = sourcesSummary(t, { place, chosen, total: scoped.length, pasted: selection.pasted.trim() !== '' })

  return (
    <Screen title={title} back={back}>
      <form className={styles.stack} onSubmit={submit}>
        <Field
          id={topicId}
          label={t('ai.sheetTopic')}
          hint={t('ai.sheetTopicHint')}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          enterKeyHint="go"
          required
        />
        <Segmented<Detail>
          label={t('ai.detail')}
          value={detail}
          onChange={setDetail}
          options={[
            { value: 'short', label: t('ai.detailShort') },
            { value: 'standard', label: t('ai.detailStandard') },
            { value: 'deep', label: t('ai.detailDeep') },
          ]}
        />
        <div className={styles.tight}>
          {/* What grounds the sheet, chosen when needed: the course or section it was opened from by default. */}
          <details className={styles.disclosure}>
            <summary className={styles.disclosureSummary}>
              <Library size={18} aria-hidden="true" className={styles.checkIcon} />
              <span className={styles.disclosureLabel}>{used}</span>
              <ChevronDown size={18} aria-hidden="true" className={styles.chevron} />
            </summary>
            <div className={styles.disclosureBody}>
              <SourcePicker value={selection} onChange={onSelection} />
            </div>
          </details>
          {photosRead > 0 && <p className={styles.hint}>{t('photos.aiUnderstandPhotos', { count: photosRead })}</p>}
        </div>
        <div className={styles.row}>
          <Button type="submit" variant="primary" loading={busy} disabled={!topic.trim()}>
            {t('ai.writeSheetSubmit')}
          </Button>
          {estimate !== null && (
            <span className={styles.hint}>
              {t('ai.cost', { amount: formatUsd(locale, estimate) })} · {ai.info.name}
            </span>
          )}
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </form>

      {sheet && <SheetDraft sheet={sheet} busy={busy} done={done !== null} validRef={validRef} />}

      {done && <SaveSheet result={done} grounded={grounded} selection={selection} place={place} onRewrite={write} />}

      <AskSelection within="article" />

      {done && <ExplainBack topic={topic.trim()} chunks={grounded} courseLanguage={courseLanguage} />}
    </Screen>
  )
}

/** The course or section a selection is in, by name: where the sheet is saved and what it is grounded in. */
function usePlaceName(selection: Selection): string {
  return useWorkspaceData(['courses', 'sections', { id: `${selection.courseId}/${selection.sectionId}` }], (ws) => {
    if (selection.sectionId !== '') {
      const section = ws.sections.tree().get(selection.sectionId)
      if (section) return section.name
    }
    return ws.courses.get(selection.courseId)?.title ?? ''
  })
}

/** The summary of the sources disclosure: what the sheet will be written from, at a glance. */
function sourcesSummary(t: T, s: { place: string; chosen: number; total: number; pasted: boolean }): string {
  let sources: string
  if (s.place === '' || (s.total > 0 && s.chosen === 0)) {
    if (s.pasted) return t('ai.sheetSourcesPasted')
    sources = t('ai.sheetSourcesNone')
  } else if (s.total === 0) {
    if (s.pasted) return t('ai.sheetSourcesPasted')
    sources = t('ai.sheetSourcesEmpty', { place: s.place })
  } else if (s.chosen === s.total) {
    sources = t('ai.sheetSourcesAll', { place: s.place })
  } else {
    sources = t('ai.sheetSourcesSome', { count: s.chosen, total: s.total, place: s.place })
  }
  return s.pasted ? t('ai.sheetPlusPasted', { sources }) : sources
}

/** A point as the study sheet's Markdown has it: its heading, then its explanation. */
function pointMarkdown(p: Point | undefined): string {
  const parts = [p?.heading?.trim() ? `## ${p.heading.trim()}` : '', p?.explanation?.trim() ?? '']
  return parts.filter((s) => s !== '').join('\n\n')
}

/**
 * The sheet as it streams in, read as a saved study sheet reads (same Markdown, same renderer), each section
 * followed by the source it cites.
 */
function SheetDraft({
  sheet,
  busy,
  done,
  validRef,
}: {
  sheet: Draft
  busy: boolean
  done: boolean
  validRef: (r: Partial<SourceRef> | undefined) => SourceRef | null
}) {
  const t = useT()
  return (
    <article className={styles.card} aria-busy={busy} aria-label={t('ai.fiche')}>
      {sheet.title && <h2 className={styles.title}>{sheet.title}</h2>}
      {sheet.summary?.trim() && <Sanitized markdown={sheet.summary.trim()} />}
      {pointKeys(sheet.points ?? []).map(({ p, key }) => {
        const ref = validRef(p?.sourceRef)
        const markdown = pointMarkdown(p)
        if (markdown === '' && !ref) return null
        return (
          <div key={key} className={styles.tight}>
            {markdown !== '' && <Sanitized markdown={markdown} />}
            {ref && <Citation sourceRef={ref} />}
          </div>
        )
      })}
      {busy && <span className={styles.cursor} aria-hidden="true" />}
      {done && <p className={styles.hint}>{t('ai.sources')}</p>}
    </article>
  )
}

/** The sheet as a study sheet's Markdown: its summary, then each point with the source it cites. */
function sheetMarkdown(result: Understanding, titleOf: (ref: SourceRef) => string | null): string {
  const parts = [result.summary.trim()]
  for (const p of result.points) {
    parts.push(`## ${p.heading.trim()}`, p.explanation.trim())
    const cited = p.sourceRef ? titleOf(p.sourceRef) : null
    if (cited) parts.push(`*${cited}*`)
  }
  return parts.filter((s) => s !== '').join('\n\n')
}

/** « Save to <course> »: the sheet kept in the course (or section) chosen, then read from its study sheets. */
function SaveSheet({
  result,
  grounded,
  selection,
  place,
  onRewrite,
}: {
  result: Understanding
  grounded: Chunk[]
  selection: Selection
  place: string
  onRewrite: () => void
}) {
  const t = useT()
  const ws = useWorkspace()
  const [saved, setSaved] = useState<string | null>(null)
  const courseId = selection.courseId
  const course = courseId ? ws.courses.get(courseId) : undefined
  const save = () => {
    if (!course) return
    const refs = result.points.flatMap((p) =>
      p.sourceRef && isValidRef(p.sourceRef, grounded) && ws.sources.get(p.sourceRef.sourceId) ? [p.sourceRef] : [],
    )
    const body = sheetMarkdown(result, (ref) =>
      refs.includes(ref) ? (ws.sources.get(ref.sourceId)?.title ?? null) : null,
    )
    const id = ws.batch(() => {
      const id = ws.fiches.create({
        courseId: course.id,
        ...(selection.sectionId ? { sectionId: selection.sectionId } : {}),
        title: result.title.trim() || t('ai.fiche'),
        sourceIds: [...new Set(refs.map((r) => r.sourceId))],
      })
      ws.text({ id, field: 'body' }).insert(0, body)
      return id
    })
    setSaved(id)
  }
  // The course opens on its study sheets, where this one now is.
  const sheets: CardNotice = { tab: 'fiches' }
  return (
    <div className={styles.tight}>
      <div className={styles.row}>
        {course && (
          <Button
            variant="primary"
            icon={<NotebookText size={18} strokeWidth={1.75} aria-hidden />}
            disabled={saved !== null}
            onClick={save}
          >
            {t('ai.saveSheetTo', { place })}
          </Button>
        )}
        <Button variant="secondary" icon={<RotateCcw size={18} aria-hidden="true" />} onClick={onRewrite}>
          {t('ai.rewrite')}
        </Button>
      </div>
      {saved !== null && course ? (
        <p className={styles.success} role="status">
          {t('ai.sheetSaved', { course: place })}{' '}
          <Link href={to.place(course.id, selection.sectionId)} state={sheets}>
            {t('ai.openSheets')}
          </Link>
        </p>
      ) : (
        !course && <p className={styles.hint}>{t('ai.sheetNeedsCourse')}</p>
      )}
    </div>
  )
}

/** Streamed points arrive in order and never reorder, so their position is their identity. */
function pointKeys(points: readonly (Point | undefined)[]): { p: Point | undefined; key: string }[] {
  return points.map((p, n) => ({ p, key: `point-${n + 1}` }))
}

/** Feynman check, folded under the sheet: the student explains the topic back and gets strengths and gaps. */
function ExplainBack({ topic, chunks, courseLanguage }: { topic: string; chunks: Chunk[]; courseLanguage?: string }) {
  const t = useT()
  const ai = useAiModel()
  const id = useId()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [review, setReview] = useState<ExplainBackReview | null>(null)
  const stream = usePartial<ExplainBackReview>()
  if (ai.status !== 'ready') return null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setError('')
    setReview(null)
    stream.reset()
    try {
      const ctx = await ai.context(new AbortController().signal, courseLanguage, passagesText(chunks))
      setReview(await explainBack({ ...ctx, onPartial: stream.onPartial }, { topic, explanation: text.trim(), chunks }))
    } catch (err) {
      setError(t('ai.failed', { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      stream.reset()
      setBusy(false)
    }
  }
  const writing = busy ? stream.partial : null

  return (
    <details className={styles.disclosure}>
      <summary className={styles.disclosureSummary}>
        <span className={styles.disclosureLabel}>{t('ai.checkUnderstood')}</span>
        <ChevronDown size={18} aria-hidden="true" className={styles.chevron} />
      </summary>
      <div className={styles.disclosureBody}>
        <p className={styles.muted}>{t('ai.explainBackHint')}</p>
        <form className={styles.tight} onSubmit={submit}>
          <label htmlFor={id} className="sr-only">
            {t('ai.explainBackLabel')}
          </label>
          <textarea
            id={id}
            className={styles.textarea}
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className={styles.row}>
            <Button type="submit" loading={busy} disabled={!text.trim()}>
              {t('ai.checkExplanation')}
            </Button>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </form>
        {writing?.feedback && (
          <div className={styles.tight} aria-busy="true">
            {typeof writing.score === 'number' && (
              <p className={styles.score}>{t('ai.explainScore', { score: Math.round(writing.score) })}</p>
            )}
            <p className={styles.body}>{writing.feedback} ▍</p>
          </div>
        )}
        {review && (
          <div className={styles.tight} role="status">
            <p className={styles.score}>{t('ai.explainScore', { score: Math.round(review.score) })}</p>
            <p className={styles.body}>{review.feedback}</p>
            <ReviewList title={t('ai.strengths')} items={review.strengths} />
            <ReviewList title={t('ai.gaps')} items={review.gaps} />
            <ReviewList title={t('ai.misconceptions')} items={review.misconceptions} />
          </div>
        )}
      </div>
    </details>
  )
}

function ReviewList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className={styles.tight}>
      <h3 className={styles.label}>{title}</h3>
      <ul className={styles.bullets}>
        {items.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </div>
  )
}
