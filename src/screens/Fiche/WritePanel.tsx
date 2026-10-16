import { ChevronDown, Library, Sparkles } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useRuntime } from '../../app/workspaceContext.tsx'
import type { Detail } from '../../core/ai/features/understand'
import { citedSources } from '../../core/ai/sheetMarkdown'
import type { Id, StudyScope } from '../../core/contracts/workspace'
import type { FicheRecord } from '../../core/model/schema'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { ExplainBack } from '../../ui/ai/ExplainBack.tsx'
import { writeSheet } from '../../ui/ai/sheetWriter.ts'
import { sourcesSummary } from '../../ui/ai/summary.ts'
import { useReadableSources } from '../../ui/ai/useReadable.ts'
import { checkExplanation, chunkLoader, placeName, type StudyDeps } from '../../ui/chat/studyRun.ts'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { useCanCallAi } from '../../ui/ExplainLauncher.tsx'
import type { EditorWriter } from '../../ui/editor/aiWrite.ts'
import { describeFailure } from '../Review/failure.ts'
import shared from '../Understand/shared/ai.module.css'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import { estimateCost } from '../Understand/shared/sources.ts'
import styles from './Fiche.module.css'

type Phase = 'idle' | 'writing' | 'done' | 'empty'

/**
 * « Write with AI », under the sheet's text: on a topic (the sheet's title, or its place), from the sources of its
 * place a model can read (the sheet's own when it has some), short or in depth. Written into the text as the model
 * writes it, the text locked meanwhile; Stop keeps what is written, the editor's Undo takes all of it back. Then the
 * explain-it-back check. `autostart`: written at once, once (a summary of a source, a sheet asked from the chat).
 */
export function WritePanel({
  fiche,
  place,
  writer,
  untitled,
  autostart,
}: {
  fiche: FicheRecord
  place: StudyScope
  writer: EditorWriter | null
  /** The sheet still has the title it was made with: the topic is its place, and the title comes from the sheet. */
  untitled: boolean
  autostart: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const ws = rt.ws
  const ai = useAiModel()
  const callable = useCanCallAi(ai)
  const titleId = useId()
  const load = useMemo(() => chunkLoader(ws, rt), [ws, rt])
  const { sources, read } = useReadableSources(place)
  const where = placeName(ws, place)
  const [topic, setTopic] = useState(() => (untitled ? where : fiche.title))
  const [detail, setDetail] = useState<Detail>('standard')
  const [picked, setPicked] = useState<readonly Id[] | null>(() =>
    fiche.sourceIds !== undefined && fiche.sourceIds.length > 0 ? fiche.sourceIds : null,
  )
  const chosen = (picked ?? sources.map((s) => s.id)).filter((id) => sources.some((s) => s.id === id))
  const chosenKey = chosen.join(',')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<number | null>(null)
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  const ready = ai.status === 'ready' ? ai : null
  const deps: StudyDeps | null = useMemo(
    () => (ready ? { ws, rt, ai: ready, t, load } : null),
    [ready, ws, rt, t, load],
  )

  // What it would cost, from the passages of the sources chosen.
  useEffect(() => {
    if (!ready) return
    let live = true
    load({ sourceIds: chosenKey === '' ? [] : chosenKey.split(','), pasted: '' }).then(
      (chunks) => {
        if (live) setEstimate(chunks.length > 0 ? estimateCost(ready.info, chunks) : null)
      },
      () => {
        if (live) setEstimate(null)
      },
    )
    return () => {
      live = false
    }
  }, [ready, load, chosenKey])

  const write = async () => {
    if (!deps || !writer || phase === 'writing') return
    const ctl = new AbortController()
    abort.current = ctl
    setPhase('writing')
    setError(null)
    try {
      const out = await writeSheet(
        deps,
        { courseId: fiche.courseId, sourceIds: chosen, topic: topic.trim() || where, detail },
        writer,
        ctl.signal,
      )
      if (out === null) {
        setPhase('empty')
        return
      }
      // The sheet takes its title from what was written, and keeps the sources it cites.
      const cited = citedSources(out).filter((id) => ws.sources.get(id) !== undefined)
      ws.fiches.update(fiche.id, {
        ...(untitled && out.title.trim() !== '' ? { title: out.title.trim() } : {}),
        sourceIds: [...new Set([...(fiche.sourceIds ?? []), ...cited])],
      })
      setPhase('done')
    } catch (e) {
      if (ctl.signal.aborted) setPhase('done')
      else {
        console.warn('study sheet not written', e)
        setError(t('chat.failed', { reason: describeFailure(e, t) }))
        setPhase('idle')
      }
    } finally {
      if (abort.current === ctl) abort.current = null
    }
  }
  const writeNow = useRef(write)
  writeNow.current = write

  // Asked to be written at once: as soon as the editor and the model are there, once.
  const started = useRef(false)
  useEffect(() => {
    if (!autostart || started.current || !writer || !deps || !callable) return
    started.current = true
    void writeNow.current()
  }, [autostart, writer, deps, callable])

  const writing = phase === 'writing'
  const cost =
    ready && estimate !== null ? `${t('ai.cost', { amount: formatUsd(locale, estimate) })} · ${ready.info.name}` : null
  const summary = sourcesSummary(t, { place: where, chosen: chosen.length, total: sources.length, pasted: false })
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.panelTitle}>
        {t('ai.writeWithAi')}
      </h2>
      <Field
        label={t('ai.sheetTopic')}
        hint={t('ai.sheetTopicHint')}
        value={topic}
        disabled={writing}
        onChange={(e) => setTopic(e.target.value)}
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
      <details className={shared.disclosure}>
        <summary className={shared.disclosureSummary}>
          <Library size={18} aria-hidden="true" className={shared.checkIcon} />
          <span className={shared.disclosureLabel}>{summary}</span>
          <ChevronDown size={18} aria-hidden="true" className={shared.chevron} />
        </summary>
        <div className={shared.disclosureBody}>
          {sources.length === 0 ? (
            <p className={shared.hint}>{t('ai.noSources')}</p>
          ) : (
            <ul className={shared.checks}>
              {sources.map((s) => (
                <li key={s.id}>
                  <label className={shared.check}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(s.id)}
                      onChange={(e) =>
                        setPicked(e.target.checked ? [...chosen, s.id] : chosen.filter((id) => id !== s.id))
                      }
                    />
                    <span>{s.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
      {read > 0 && <p className={shared.hint}>{t('photos.aiUnderstandPhotos', { count: read })}</p>}
      <div className={shared.row}>
        {writing ? (
          <Button variant="secondary" onClick={() => abort.current?.abort()}>
            {t('chat.stop')}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Sparkles size={18} aria-hidden="true" />}
            disabled={!callable || !deps || !writer || chosen.length === 0}
            onClick={() => void write()}
          >
            {t('ai.writeWithAi')}
          </Button>
        )}
        {cost !== null && <span className={shared.hint}>{cost}</span>}
      </div>
      {!callable && <p className={styles.note}>{t('chat.offline')}</p>}
      <p className={shared.hint} role="status">
        {writing
          ? t('chat.writing')
          : phase === 'done'
            ? t('ai.sheetWritten')
            : phase === 'empty'
              ? t('ai.sheetNothingToRead')
              : ''}
      </p>
      {error && (
        <p className={shared.error} role="alert">
          {error}
        </p>
      )}
      {deps && (
        <ExplainBack
          blocked={!callable || writing}
          check={(explanation, onPartial) =>
            checkExplanation(
              deps,
              {
                courseId: fiche.courseId,
                ...(place.sectionId === undefined ? {} : { sectionId: place.sectionId }),
                sourceIds: chosen,
                pasted: '',
                topic: fiche.title,
                count: 10,
                detail,
              },
              explanation,
              { signal: new AbortController().signal, onPartial },
            )
          }
        />
      )}
    </section>
  )
}
