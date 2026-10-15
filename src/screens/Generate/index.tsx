import { Presentation, Trash2 } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react'
import { Link } from 'wouter'
import { readEntry, writeEntry } from '../../app/nav.ts'
import { paths, to, withScope } from '../../app/routes.ts'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import { generateCards } from '../../core/ai/features/generateCards'
import type { CardDraft } from '../../core/ai/schemas'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { streamedKeys, usePartial } from '../../ui/data/usePartial.ts'
import { Screen } from '../../ui/shell/Screen.tsx'
import { UpLink } from '../../ui/UpLink.tsx'
import { useScopeOnce } from '../Section/scope.ts'
import styles from '../Understand/shared/ai.module.css'
import { passagesText, useAiModel } from '../Understand/shared/aiConfig.ts'
import {
  Citation,
  NoModel,
  type Selection,
  SourcePicker,
  selectionFor,
  useChunkLoader,
} from '../Understand/shared/SourcePicker.tsx'
import { estimateCost, PASTED } from '../Understand/shared/sources.ts'
import { dedupeDrafts } from './dedupe.ts'

interface Draft extends CardDraft {
  key: string
}

const COUNTS = ['5', '10', '20'] as const

/** Drafts kept in this screen's history entry. */
const KEPT = 'cursusGenerate'
type Kept = { drafts: Draft[] | null; dropped: number }

/** The course or section chosen, as a study scope (none while no course is chosen). */
function scopeOf(selection: Selection): { courseId: string; sectionId?: string } | null {
  if (selection.courseId === '') return null
  return selection.sectionId === ''
    ? { courseId: selection.courseId }
    : { courseId: selection.courseId, sectionId: selection.sectionId }
}

export default function Generate() {
  const t = useT()
  const locale = useLocale()
  const ws = useWorkspace()
  const ai = useAiModel()
  const loadChunks = useChunkLoader()
  const opened = useScopeOnce()
  // Back to the course or section it was opened from, else to the courses.
  const back = opened ? to.place(opened.courseId, opened.sectionId) : paths.courses
  const [selection, setSelection] = useState<Selection>(() => selectionFor(opened))
  const [topic, setTopic] = useState('')
  const [count, setCount] = useState<(typeof COUNTS)[number]>('10')
  const [estimate, setEstimate] = useState<number | null>(null)
  // Drafts on screen stay with this history entry: back from « Understand » or an import, they are still there.
  const [kept] = useState(() => readEntry<Kept>(KEPT))
  const [drafts, setDrafts] = useState<Draft[] | null>(kept?.drafts ?? null)
  const [dropped, setDropped] = useState(kept?.dropped ?? 0)
  useEffect(() => {
    const keep: Kept = { drafts, dropped }
    writeEntry(KEPT, keep)
  }, [drafts, dropped])
  const [saved, setSaved] = useState<{ count: number; courseId: string; sectionId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const onSelection = useCallback((s: Selection) => setSelection(s), [])
  const stream = usePartial<{ cards: CardDraft[] }>()

  useEffect(() => {
    if (ai.status !== 'ready') return
    let live = true
    loadChunks(selection).then(
      (chunks) => {
        if (live) setEstimate(estimateCost(ai.info, chunks, 150 * Number(count)))
      },
      () => {
        if (live) setEstimate(null)
      },
    )
    return () => {
      live = false
    }
  }, [ai, selection, count, loadChunks])

  if (ai.status === 'loading') return <Screen title={t('ai.generate')} back={back} />
  if (ai.status === 'missing')
    return (
      <Screen title={t('ai.generate')} back={back}>
        <NoModel reason={ai.reason} />
      </Screen>
    )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    setSaved(null)
    setDrafts(null)
    stream.reset()
    try {
      const chunks = await loadChunks(selection)
      const ctx = await ai.context(
        new AbortController().signal,
        ws.courses.get(selection.courseId)?.language,
        passagesText(chunks),
      )
      const out = await generateCards(
        { ...ctx, onPartial: stream.onPartial },
        {
          topic: topic.trim() || t('ai.wholeSelection'),
          chunks,
          count: Number(count),
        },
      )
      const existing = ws.cards
        .list({ courseId: selection.courseId })
        .map((c) => ws.text({ id: c.id, field: 'front' }).toString())
      const { kept, dropped: n } = dedupeDrafts(out, existing)
      setDrafts(kept.map((d, i) => ({ ...d, key: `${Date.now()}-${i}` })))
      setDropped(n)
    } catch (err) {
      setError(t('ai.failed', { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      stream.reset()
      setBusy(false)
    }
  }
  const writing = busy ? (stream.partial?.cards ?? []).filter((c) => c?.front) : []

  const edit = (key: string, patch: Partial<CardDraft>) =>
    setDrafts((ds) => ds?.map((d) => (d.key === key ? { ...d, ...patch } : d)) ?? null)
  const remove = (key: string) => setDrafts((ds) => ds?.filter((d) => d.key !== key) ?? null)

  const save = () => {
    if (!drafts || !selection.courseId) return
    const keep = drafts.filter((d) => d.front.trim())
    ws.batch(() => {
      for (const d of keep) {
        const sourceId = d.sourceRef && d.sourceRef.sourceId !== PASTED ? d.sourceRef.sourceId : undefined
        // Drafts made from a section land in it.
        const place = selection.sectionId === '' ? {} : { sectionId: selection.sectionId }
        const id = ws.cards.create({ courseId: selection.courseId, ...place, kind: d.kind, origin: 'ai', sourceId })
        ws.text({ id, field: 'front' }).insert(0, d.front.trim())
        if (d.back.trim()) ws.text({ id, field: 'back' }).insert(0, d.back.trim())
      }
    })
    setSaved({ count: keep.length, courseId: selection.courseId, sectionId: selection.sectionId })
    setDrafts(null)
    setDropped(0)
  }

  return (
    <Screen title={t('ai.generate')} back={back}>
      <Link href={withScope(paths.deckImport, scopeOf(selection))} className={buttonClass({ variant: 'secondary' })}>
        <Presentation size={18} aria-hidden="true" />
        {t('ai.deckFromFile')}
      </Link>
      <form className={styles.stack} onSubmit={submit}>
        <Field label={t('ai.topicOptional')} value={topic} onChange={(e) => setTopic(e.target.value)} />
        <Segmented
          label={t('ai.cardCount')}
          value={count}
          onChange={setCount}
          options={COUNTS.map((c) => ({ value: c, label: c }))}
        />
        <SourcePicker value={selection} onChange={onSelection} />
        <div className={styles.row}>
          <Button type="submit" variant="primary" loading={busy} disabled={!selection.courseId}>
            {t('ai.generateDrafts')}
          </Button>
          {estimate !== null && (
            <span className={styles.hint}>
              {t('ai.cost', { amount: formatUsd(locale, estimate) })} · {ai.info.name}
            </span>
          )}
        </div>
        {!selection.courseId && <p className={styles.hint}>{t('ai.needCourse')}</p>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </form>

      {saved && (
        <p className={styles.success} role="status">
          {t('ai.saved', { count: saved.count })}{' '}
          <UpLink href={to.place(saved.courseId, saved.sectionId)}>{t('ai.openCourse')}</UpLink>
        </p>
      )}

      {writing.length > 0 && (
        <section className={styles.stack} aria-label={t('ai.drafts')} aria-busy="true">
          <p className={styles.heading}>{t('ai.writingCards', { count: writing.length })}</p>
          <ol className={styles.list}>
            {streamedKeys(writing).map(({ item: c, key, last }) => (
              <li key={key} className={styles.card}>
                <p className={styles.body}>{last && !c?.back ? `${c?.front ?? ''} ▍` : c?.front}</p>
                {c?.back && <p className={styles.muted}>{last ? `${c.back} ▍` : c.back}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {drafts && (
        <section className={styles.stack} aria-label={t('ai.drafts')}>
          <div className={styles.tight} role="status">
            <p className={styles.heading}>{t('ai.generated', { count: drafts.length })}</p>
            {dropped > 0 && <p className={styles.hint}>{t('ai.duplicatesDropped', { count: dropped })}</p>}
          </div>
          <ol className={styles.list}>
            {drafts.map((d, i) => (
              <DraftEditor
                key={d.key}
                index={i + 1}
                draft={d}
                onChange={(p) => edit(d.key, p)}
                onRemove={() => remove(d.key)}
              />
            ))}
          </ol>
          <div className={styles.row}>
            <Button variant="primary" onClick={save} disabled={drafts.length === 0}>
              {t('ai.saveCards', { count: drafts.length })}
            </Button>
            <Button variant="plain" onClick={() => setDrafts(null)}>
              {t('ai.discard')}
            </Button>
            <Link href={withScope(paths.understand, scopeOf(selection))} className={buttonClass({ variant: 'plain' })}>
              {t('ai.understand')}
            </Link>
          </div>
        </section>
      )}
    </Screen>
  )
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
    <li className={styles.card}>
      <div className={styles.row}>
        <span className={styles.badge}>{draft.kind === 'cloze' ? t('ai.kindCloze') : t('ai.kindBasic')}</span>
        {draft.sourceRef && <Citation sourceRef={draft.sourceRef} />}
        <span className={styles.spacer} />
        <IconButton icon={Trash2} label={t('ai.removeDraft', { n: String(index) })} onClick={onRemove} />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-f`}>
          {t('ai.front', { n: String(index) })}
        </label>
        <textarea
          id={`${id}-f`}
          className={styles.textarea}
          rows={2}
          value={draft.front}
          onChange={(e) => onChange({ front: e.target.value })}
        />
      </div>
      {draft.kind === 'basic' && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-b`}>
            {t('ai.back', { n: String(index) })}
          </label>
          <textarea
            id={`${id}-b`}
            className={styles.textarea}
            rows={2}
            value={draft.back}
            onChange={(e) => onChange({ back: e.target.value })}
          />
        </div>
      )}
    </li>
  )
}
