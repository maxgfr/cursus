import { ListChecks, Sparkles } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { paths } from '../../app/routes.ts'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import { explainBack } from '../../core/ai/features/explainBack'
import { type Chunk, isValidRef } from '../../core/ai/retrieval'
import type { ExplainBackReview, SourceRef, Understanding } from '../../core/ai/schemas'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './shared/ai.module.css'
import { useAiModel } from './shared/aiConfig.ts'
import {
  Citation,
  emptySelection,
  NoModel,
  type Selection,
  SourcePicker,
  useChunkLoader,
} from './shared/SourcePicker.tsx'
import { estimateCost } from './shared/sources.ts'
import { type Level, streamUnderstanding } from './stream.ts'

type Point = { heading?: string; explanation?: string; sourceRef?: Partial<SourceRef> }

export default function Understand() {
  const t = useT()
  const locale = useLocale()
  const ws = useWorkspace()
  const ai = useAiModel()
  const loadChunks = useChunkLoader()
  const [selection, setSelection] = useState<Selection>(emptySelection)
  const [topic, setTopic] = useState('')
  const [level, setLevel] = useState<Level>('standard')
  const [estimate, setEstimate] = useState<number | null>(null)
  const [fiche, setFiche] = useState<{ title?: string; summary?: string; points?: (Point | undefined)[] } | null>(null)
  const [done, setDone] = useState<Understanding | null>(null)
  const [grounded, setGrounded] = useState<Chunk[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)

  const onSelection = useCallback((s: Selection) => setSelection(s), [])

  // Estimated cost of the next request, refreshed as the selection changes.
  useEffect(() => {
    if (ai.status !== 'ready') return
    let live = true
    loadChunks(selection).then(
      (chunks) => {
        if (live) setEstimate(estimateCost(ai.info, chunks))
      },
      () => {
        if (live) setEstimate(null)
      },
    )
    return () => {
      live = false
    }
  }, [ai, selection, loadChunks])

  useEffect(() => () => abort.current?.abort(), [])

  if (ai.status === 'loading') return <Screen title={t('ai.understand')} />
  if (ai.status === 'missing')
    return (
      <Screen title={t('ai.understand')}>
        <NoModel />
        <MoreTools />
      </Screen>
    )

  const courseLanguage = ws.courses.get(selection.courseId)?.language

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!topic.trim()) return
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setBusy(true)
    setError('')
    setFiche(null)
    setDone(null)
    try {
      const chunks = await loadChunks(selection)
      const ctx = await ai.context(ctl.signal, courseLanguage)
      const s = streamUnderstanding(ctx, { topic: topic.trim(), level, chunks })
      setGrounded(s.grounded)
      for await (const part of s.partial) setFiche(part)
      const out = await s.output
      setFiche(out)
      setDone(out)
    } catch (err) {
      if (!ctl.signal.aborted) setError(t('ai.failed', { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const validRef = (r: Partial<SourceRef> | undefined): SourceRef | null =>
    r?.sourceId && isValidRef({ sourceId: r.sourceId, page: r.page }, grounded)
      ? { sourceId: r.sourceId, page: r.page }
      : null

  return (
    <Screen title={t('ai.understand')}>
      <form className={styles.stack} onSubmit={submit}>
        <Field
          label={t('ai.explainPrompt')}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          enterKeyHint="go"
          required
        />
        <Segmented<Level>
          label={t('ai.level')}
          value={level}
          onChange={setLevel}
          options={[
            { value: 'basics', label: t('ai.levelBasics') },
            { value: 'standard', label: t('ai.levelStandard') },
            { value: 'deep', label: t('ai.levelDeep') },
          ]}
        />
        <SourcePicker value={selection} onChange={onSelection} />
        <div className={styles.row}>
          <Button type="submit" variant="primary" loading={busy} disabled={!topic.trim()}>
            {t('ai.explain')}
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

      {fiche && (
        <article className={styles.card} aria-busy={busy} aria-label={t('ai.fiche')}>
          {fiche.title && <h2 className={styles.title}>{fiche.title}</h2>}
          {fiche.summary && <p className={styles.muted}>{fiche.summary}</p>}
          <ol className={styles.points}>
            {pointKeys(fiche.points ?? []).map(({ p, key }) => {
              const ref = validRef(p?.sourceRef)
              return (
                <li key={key} className={styles.tight}>
                  {p?.heading && <h3 className={styles.heading}>{p.heading}</h3>}
                  {p?.explanation && <p className={styles.body}>{p.explanation}</p>}
                  {ref && <Citation sourceRef={ref} />}
                </li>
              )
            })}
          </ol>
          {busy && <span className={styles.cursor} aria-hidden="true" />}
          {done && <p className={styles.hint}>{t('ai.sources')}</p>}
        </article>
      )}

      {done && <ExplainBack topic={topic.trim()} chunks={grounded} courseLanguage={courseLanguage} />}

      <MoreTools />
    </Screen>
  )
}

/** Generate and Quiz stay one tap away from Understand, with or without a model set up. */
function MoreTools() {
  const t = useT()
  return (
    <ListGroup title={t('common.more')} hideTitle>
      <ListRow href={paths.generate} leading={<Sparkles size={20} />} title={t('ai.generate')} />
      <ListRow href={paths.quiz} leading={<ListChecks size={20} />} title={t('ai.quiz')} />
    </ListGroup>
  )
}

/** Streamed points arrive in order and never reorder, so their position is their identity. */
function pointKeys(points: readonly (Point | undefined)[]): { p: Point | undefined; key: string }[] {
  return points.map((p, n) => ({ p, key: `point-${n + 1}` }))
}

/** Feynman check: the student explains the topic back and gets strengths, gaps and misconceptions. */
function ExplainBack({ topic, chunks, courseLanguage }: { topic: string; chunks: Chunk[]; courseLanguage?: string }) {
  const t = useT()
  const ai = useAiModel()
  const id = useId()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [review, setReview] = useState<ExplainBackReview | null>(null)
  if (ai.status !== 'ready') return null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setError('')
    try {
      const ctx = await ai.context(new AbortController().signal, courseLanguage)
      setReview(await explainBack(ctx, { topic, explanation: text.trim(), chunks }))
    } catch (err) {
      setError(t('ai.failed', { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.card} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className={styles.heading}>
        {t('ai.explainBack')}
      </h2>
      <p className={styles.muted}>{t('ai.explainBackHint')}</p>
      <form className={styles.tight} onSubmit={submit}>
        <label htmlFor={id} className="sr-only">
          {t('ai.explainBackLabel')}
        </label>
        <textarea id={id} className={styles.textarea} rows={5} value={text} onChange={(e) => setText(e.target.value)} />
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
      {review && (
        <div className={styles.tight} role="status">
          <p className={styles.score}>{t('ai.explainScore', { score: Math.round(review.score) })}</p>
          <p className={styles.body}>{review.feedback}</p>
          <ReviewList title={t('ai.strengths')} items={review.strengths} />
          <ReviewList title={t('ai.gaps')} items={review.gaps} />
          <ReviewList title={t('ai.misconceptions')} items={review.misconceptions} />
        </div>
      )}
    </section>
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
