import { Play, Save, Sparkles, Square, Trash2, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { outputLanguage } from '../../core/ai/client'
import {
  CardTextIndex,
  type DifficultyMix,
  deckQuestions,
  estimateDeckQuestionsCost,
  MAX_QUESTIONS_PER_UNIT,
  QUESTION_TYPES,
  type QuestionType,
} from '../../core/ai/features/deckQuestions'
import { supportsImages } from '../../core/ai/features/readDeck'
import type { DeckUnit } from '../../core/content/deck'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import base from '../DeckImport/DeckImport.module.css'
import { deckErrorMessage, type LoadedDeck, loadDeck, unitCount, unitName } from '../DeckImport/deckSource.ts'
import { PlacePicker } from '../DeckImport/places.tsx'
import { type Thumb, useUnitThumbs } from '../DeckImport/thumbs.ts'
import NotFound from '../NotFound/index.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import styles from './DeckQuestions.module.css'
import { type DraftGroup, DraftReview } from './DraftReview.tsx'
import { estimateInputs, runInputs, saveDraftCards } from './deckInputs.ts'
import { type DeckRun, type DeckSettings, draftsFor, keepRun, readRun, remainingUnits } from './deckRun.ts'

const PER_UNIT = ['1', '2', '3', '5'] as const
const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
] as const

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}

/** The units a setting covers: the range, hidden slides left out unless asked for. */
function selectedUnits(units: readonly DeckUnit[], s: DeckSettings): DeckUnit[] {
  return units.filter((u) => u.index >= s.from && u.index <= s.to && (s.hidden || !u.hidden))
}

function defaultSettings(units: readonly DeckUnit[], sectionId: string): DeckSettings {
  return {
    from: units[0]?.index ?? 1,
    to: units.at(-1)?.index ?? 1,
    perUnit: 2,
    types: ['qa', 'cloze'],
    difficulty: 'mixed',
    language: '',
    sectionId,
    hidden: false,
  }
}

/** A run is active while it has drafts to review or units left to do. */
const isActive = (run: DeckRun | null): run is DeckRun =>
  run !== null && (run.drafts.length > 0 || remainingUnits(run).length > 0)

/**
 * « Créer les questions depuis un support », step two: choose the slides or sections, the number and kinds of
 * questions, see the cost, run unit by unit (cancel and resume at any time: progress and drafts stay on this
 * device), then review the drafts grouped by unit and save the accepted ones as cards.
 */
export default function DeckQuestions() {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const { id = '' } = useParams<{ id: string }>()
  const found = useWorkspaceData(['sources', 'sections', 'courses', { id }], (ws) => {
    const s = ws.sources.get(id)
    if (!s || s.deletedAt !== undefined || s.support === undefined) return null
    const course = ws.courses.get(s.courseId)
    return { source: s, sectionId: ws.sections.tree().sectionOf(s), course }
  })
  const ai = useAiModel()
  const online = useOnline()
  const [loaded, setLoaded] = useState<LoadedDeck | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const thumbs = useUnitThumbs(loaded)
  const [run, setRunState] = useState<DeckRun | null | undefined>(undefined)
  const runRef = useRef<DeckRun | null>(null)
  const writes = useRef<Promise<void>>(Promise.resolve())
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [settings, setSettings] = useState<DeckSettings | null>(null)
  const [running, setRunning] = useState<AbortController | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [discarded, setDiscarded] = useState<DeckRun | null>(null)
  const [leftOut, setLeftOut] = useState(0)

  const source = found?.source
  useEffect(() => {
    if (!source) return
    let live = true
    setLoadError(null)
    loadDeck(rt, source).then(
      (l) => {
        if (live) setLoaded(l)
      },
      (e: unknown) => {
        noteError('deck.load', e)
        if (live) setLoadError(deckErrorMessage(t, e))
      },
    )
    return () => {
      live = false
    }
  }, [rt, source, t])

  useEffect(() => {
    let live = true
    readRun(rt.store, id).then(
      (r) => {
        if (!live) return
        runRef.current = r
        setRunState(r)
      },
      (e: unknown) => {
        noteError('deck.run', e)
        if (live) setRunState(null)
      },
    )
    return () => {
      live = false
    }
  }, [rt, id])

  useEffect(() => {
    if (loaded && settings === null && run !== undefined) {
      setSettings(run?.settings ?? defaultSettings(loaded.deck.units, found?.sectionId ?? ''))
    }
  }, [loaded, settings, run, found?.sectionId])

  /** Every change to the run goes through here: state now, then written to the device in order. */
  const update = useCallback(
    (fn: (r: DeckRun | null) => DeckRun | null, delay = 0) => {
      const next = fn(runRef.current)
      runRef.current = next
      setRunState(next)
      const write = () => {
        writes.current = writes.current
          .then(() => keepRun(rt.store, id, runRef.current))
          .catch((e: unknown) => {
            noteError('deck.keep', e)
            setError(t('ai.deckKeepFailed'))
          })
      }
      if (editTimer.current !== null) clearTimeout(editTimer.current)
      editTimer.current = null
      if (delay > 0) editTimer.current = setTimeout(write, delay)
      else write()
    },
    [rt, id, t],
  )

  // Leaving with an edit not yet written: write it now.
  useEffect(
    () => () => {
      if (editTimer.current === null) return
      clearTimeout(editTimer.current)
      void keepRun(rt.store, id, runRef.current).catch((e: unknown) => noteError('deck.keep', e))
    },
    [rt, id],
  )
  // Leaving mid-run stops it; what finished is kept.
  useEffect(() => () => running?.abort(), [running])

  const existing = useMemo(() => {
    if (!source) return []
    return rt.ws.cards
      .list({ courseId: source.courseId })
      .map((c) => rt.ws.text({ id: c.id, field: 'front' }).toString())
  }, [rt, source])

  const units = useMemo(
    () => (loaded && settings ? selectedUnits(loaded.deck.units, settings) : []),
    [loaded, settings],
  )
  const estimate = useMemo(() => {
    if (ai.status !== 'ready' || !loaded || !settings || units.length === 0) return null
    return estimateDeckQuestionsCost(ai.info, {
      sourceId: id,
      units: estimateInputs(
        loaded,
        units.map((u) => u.index),
      ),
      perUnit: settings.perUnit,
      types: settings.types,
      difficulty: settings.difficulty,
      existing,
    })
  }, [ai, loaded, settings, units, id, existing])

  if (found === null) return <NotFound />
  const { course } = found
  const back = to.source(id)
  const title = t('ai.deckQuestionsTitle')
  if (source === undefined) return null

  if (loadError !== null) {
    return (
      <Screen title={title} subtitle={source.title} back={back}>
        <p className={base.error} role="alert">
          {loadError}
        </p>
      </Screen>
    )
  }
  if (!loaded || !settings || run === undefined) {
    return (
      <Screen title={title} subtitle={source.title} back={back}>
        <p className={base.hint} role="status">
          {t('ai.deckLoading')}
        </p>
      </Screen>
    )
  }

  const deck = loaded.deck
  const kind = deck.units[0]?.kind ?? 'page'
  const canRun = ai.status === 'ready' && (online || ai.runsOffline)
  const active = isActive(run)

  const start = async (resume: boolean) => {
    if (ai.status !== 'ready' || running) return
    const prev = runRef.current
    const s = resume && prev ? prev.settings : settings
    const indexes = resume && prev ? prev.units : units.map((u) => u.index)
    if (!resume) {
      update(() => ({
        v: 1,
        settings: s,
        units: indexes,
        progress: { done: {} },
        textOnly: (estimate?.imagesUnseen ?? 0) > 0,
        drafts: [],
        rejected: prev?.rejected ?? [],
        duplicates: 0,
      }))
    }
    const current = runRef.current
    if (current === null) return
    const controller = new AbortController()
    setRunning(controller)
    setError(null)
    setNotice(null)
    setSaved(null)
    setLeftOut(0)
    try {
      const ctx0 = await ai.context(controller.signal, course?.language)
      const ctx = s.language === '' ? ctx0 : { ...ctx0, language: outputLanguage(s.language, 'en') }
      setPreparing(true)
      const inputs = await runInputs(loaded, remainingUnits(current), supportsImages(ctx.info), controller.signal)
      setPreparing(false)
      setLeftOut(inputs.leftOut)
      const rejected = new CardTextIndex(current.rejected)
      const result = await deckQuestions(ctx, {
        sourceId: id,
        units: inputs.units,
        perUnit: s.perUnit,
        types: s.types,
        difficulty: s.difficulty,
        courseTitle: course?.title,
        deckTitle: source.title,
        existing,
        isDuplicate: (q) => rejected.has(q.front),
        resume: current.progress,
        feature: 'deckQuestions',
        onProgress: (progress, finished) =>
          update((r) =>
            r === null ? r : { ...r, progress, drafts: [...r.drafts, ...draftsFor(finished, progress.done)] },
          ),
      })
      update((r) =>
        r === null
          ? r
          : { ...r, textOnly: r.textOnly || result.textOnly, duplicates: r.duplicates + result.duplicates },
      )
    } catch (e) {
      setPreparing(false)
      if (controller.signal.aborted) {
        setNotice(t('ai.deckStopped'))
      } else {
        noteError('deck.questions', e)
        setError(t('ai.failed', { reason: e instanceof Error ? e.message : String(e) }))
      }
    } finally {
      setRunning(null)
    }
  }

  const setStatus = (ids: readonly string[], status: 'pending' | 'accepted' | 'rejected') => {
    const set = new Set(ids)
    update((r) => (r === null ? r : { ...r, drafts: r.drafts.map((d) => (set.has(d.id) ? { ...d, status } : d)) }))
  }
  const edit = (draftId: string, patch: { front?: string; back?: string }) =>
    update(
      (r) => (r === null ? r : { ...r, drafts: r.drafts.map((d) => (d.id === draftId ? { ...d, ...patch } : d)) }),
      400,
    )

  const save = () => {
    const r = runRef.current
    if (r === null) return
    const keep = r.drafts.filter((d) => d.status === 'accepted' && d.front.trim() !== '')
    if (keep.length === 0) return
    saveDraftCards(rt.ws, source, r.settings.sectionId, keep)
    const savedIds = new Set(keep.map((d) => d.id))
    update((cur) =>
      cur === null
        ? cur
        : {
            ...cur,
            drafts: cur.drafts.filter((d) => !savedIds.has(d.id) && d.status !== 'rejected'),
            rejected: [...cur.rejected, ...cur.drafts.filter((d) => d.status === 'rejected').map((d) => d.front)],
          },
    )
    setSaved(keep.length)
  }

  const discard = () => {
    const r = runRef.current
    if (r === null) return
    setDiscarded(r)
    update((cur) =>
      cur === null
        ? cur
        : {
            ...cur,
            units: [],
            progress: { done: {} },
            drafts: [],
            rejected: [...cur.rejected, ...cur.drafts.filter((d) => d.status === 'rejected').map((d) => d.front)],
          },
    )
  }

  const unitsByIndex = new Map(deck.units.map((u) => [u.index, u]))
  const groups: DraftGroup[] = []
  if (run !== null) {
    for (const index of run.units) {
      const drafts = run.drafts.filter((d) => d.unit === index)
      const u = unitsByIndex.get(index)
      if (drafts.length === 0 || !u) continue
      const thumb = thumbs.get(index)
      const g: DraftGroup = {
        key: String(index),
        name: unitName(t, u),
        href: `${to.source(id)}?page=${index}`,
        drafts,
      }
      if (u.title) g.title = u.title
      if (thumb) g.thumb = thumb
      groups.push(g)
    }
  }
  const accepted = run?.drafts.filter((d) => d.status === 'accepted').length ?? 0
  const savedPlace = run?.settings.sectionId ?? settings.sectionId

  return (
    <Screen title={title} subtitle={source.title} back={back}>
      <div className={base.stack}>
        {ai.status === 'missing' && (
          <EmptyState
            icon={Sparkles}
            level={2}
            title={t('ai.deckNoModelTitle')}
            body={t('ai.deckNoModel')}
            action={
              <Link href={paths.settingsAi} className={buttonClass({ variant: 'primary' })}>
                {t('ai.openSettings')}
              </Link>
            }
          />
        )}
        {ai.status === 'ready' && !online && !ai.runsOffline && (
          <p className={styles.notice} role="status">
            <WifiOff size={18} aria-hidden="true" />
            {t('ai.deckOffline')}
          </p>
        )}

        {saved !== null && (
          <p className={base.success} role="status">
            {t('ai.saved', { count: saved })}{' '}
            <Link href={to.place(source.courseId, savedPlace || null)}>{t('ai.openCourse')}</Link>
          </p>
        )}

        {!active && !running && (
          <Setup
            deckUnits={deck.units}
            kind={kind}
            settings={settings}
            onChange={setSettings}
            courseId={source.courseId}
            count={units.length}
          />
        )}

        {!active && !running && ai.status === 'ready' && (
          <div className={base.tight}>
            {estimate !== null && (
              <p className={base.hint} data-testid="deck-estimate">
                {t('ai.cost', { amount: formatUsd(locale, estimate.cost) })} · {unitCount(t, { units })} ·{' '}
                {ai.info.name}
              </p>
            )}
            {estimate !== null && estimate.imagesUnseen > 0 && (
              <p className={styles.notice} role="note">
                {t('ai.deckTextOnly')}
              </p>
            )}
            <div className={base.row}>
              <Button
                variant="primary"
                icon={<Sparkles size={18} aria-hidden="true" />}
                disabled={!canRun || units.length === 0}
                onClick={() => void start(false)}
              >
                {t('ai.deckRun')}
              </Button>
            </div>
          </div>
        )}

        {(active || running) && run !== null && (
          <Progress
            run={run}
            units={unitsByIndex}
            thumbs={thumbs}
            running={running !== null}
            preparing={preparing}
            kind={kind}
          />
        )}

        {(active || running) && run !== null && (
          <div className={base.row}>
            {running ? (
              <Button icon={<Square size={18} aria-hidden="true" />} onClick={() => running.abort()}>
                {t('ai.deckCancel')}
              </Button>
            ) : (
              remainingUnits(run).length > 0 && (
                <Button
                  variant="primary"
                  icon={<Play size={18} aria-hidden="true" />}
                  disabled={!canRun}
                  onClick={() => void start(true)}
                >
                  {t('ai.deckResume')}
                </Button>
              )
            )}
            {!running && (
              <Button variant="plain" icon={<Trash2 size={18} aria-hidden="true" />} onClick={discard}>
                {t('ai.deckDiscard')}
              </Button>
            )}
          </div>
        )}

        {notice !== null && (
          <p className={base.hint} role="status">
            {notice}
          </p>
        )}
        {error !== null && (
          <p className={base.error} role="alert">
            {error}
          </p>
        )}
        {run?.textOnly && run.drafts.length > 0 && (
          <p className={styles.notice} role="note">
            {t('ai.deckTextOnlyDone')}
          </p>
        )}
        {leftOut > 0 && <p className={base.hint}>{t('ai.deckLeftOut', { count: leftOut })}</p>}
        {run !== null && run.duplicates > 0 && run.drafts.length > 0 && (
          <p className={base.hint}>{t('ai.duplicatesDropped', { count: run.duplicates })}</p>
        )}

        {groups.length > 0 && run !== null && (
          <section className={base.stack} aria-labelledby="deck-drafts">
            <h2 id="deck-drafts" className={base.heading}>
              {t('ai.deckReviewTitle')}
            </h2>
            <DraftReview
              groups={groups}
              onAccept={(ids) => setStatus(ids, 'accepted')}
              onReject={(ids) => setStatus(ids, 'rejected')}
              onRestore={(ids) => setStatus(ids, 'pending')}
              onEdit={edit}
              level={3}
            />
            <div className={styles.saveBar}>
              <PlacePicker
                value={{ courseId: source.courseId, sectionId: run.settings.sectionId }}
                onChange={(p) =>
                  update((r) => (r === null ? r : { ...r, settings: { ...r.settings, sectionId: p.sectionId } }))
                }
                courseLabel={t('ai.course')}
                sectionLabel={t('ai.deckSaveCardsIn')}
                fixedCourse
              />
              <Button
                variant="primary"
                icon={<Save size={18} aria-hidden="true" />}
                disabled={accepted === 0}
                onClick={save}
              >
                {t('ai.saveCards', { count: accepted })}
              </Button>
            </div>
          </section>
        )}
      </div>
      {discarded !== null && (
        <Toast
          message={t('ai.deckDiscarded')}
          actions={[
            {
              label: t('course.undo'),
              onClick: () => {
                update(() => discarded)
                setDiscarded(null)
              },
            },
            { label: t('common.dismiss'), onClick: () => setDiscarded(null) },
          ]}
        />
      )}
    </Screen>
  )
}

function Setup({
  deckUnits,
  kind,
  settings,
  onChange,
  courseId,
  count,
}: {
  deckUnits: readonly DeckUnit[]
  kind: DeckUnit['kind']
  settings: DeckSettings
  onChange: (s: DeckSettings) => void
  courseId: string
  count: number
}) {
  const t = useT()
  const fromId = useId()
  const toId = useId()
  const languageId = useId()
  const set = (patch: Partial<DeckSettings>) => onChange({ ...settings, ...patch })
  const inRange = deckUnits.filter((u) => u.index >= settings.from && u.index <= settings.to)
  const hidden = inRange.filter((u) => u.hidden).length
  const option = (u: DeckUnit) => (u.title ? `${unitName(t, u)} · ${u.title}` : unitName(t, u))
  const toggleType = (type: QuestionType, on: boolean) => {
    const types = QUESTION_TYPES.filter((q) => (q === type ? on : settings.types.includes(q)))
    if (types.length > 0) set({ types })
  }
  const perUnitLabel =
    kind === 'slide' ? t('ai.deckPerSlide') : kind === 'section' ? t('ai.deckPerSection') : t('ai.deckPerPage')
  return (
    <div className={base.stack}>
      <fieldset className={styles.fieldset}>
        <legend className={base.label}>{t('ai.deckRange')}</legend>
        <div className={styles.range}>
          <div className={base.field}>
            <label className={base.label} htmlFor={fromId}>
              {t('ai.deckFrom')}
            </label>
            <select
              id={fromId}
              className={base.select}
              value={settings.from}
              onChange={(e) => {
                const from = Number(e.target.value)
                set({ from, to: Math.max(from, settings.to) })
              }}
            >
              {deckUnits.map((u) => (
                <option key={u.index} value={u.index}>
                  {option(u)}
                </option>
              ))}
            </select>
          </div>
          <div className={base.field}>
            <label className={base.label} htmlFor={toId}>
              {t('ai.deckTo')}
            </label>
            <select
              id={toId}
              className={base.select}
              value={settings.to}
              onChange={(e) => {
                const to = Number(e.target.value)
                set({ to, from: Math.min(to, settings.from) })
              }}
            >
              {deckUnits.map((u) => (
                <option key={u.index} value={u.index}>
                  {option(u)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {hidden > 0 && (
          <label className={styles.check}>
            <input type="checkbox" checked={settings.hidden} onChange={(e) => set({ hidden: e.target.checked })} />
            <span>{t('ai.deckIncludeHidden', { count: hidden })}</span>
          </label>
        )}
        <p className={base.hint}>{t('ai.deckSelected', { count })}</p>
      </fieldset>
      <Segmented
        label={perUnitLabel}
        value={String(settings.perUnit) as (typeof PER_UNIT)[number]}
        onChange={(v) => set({ perUnit: Math.min(MAX_QUESTIONS_PER_UNIT, Number(v)) })}
        options={PER_UNIT.map((n) => ({ value: n, label: n }))}
      />
      <fieldset className={styles.fieldset}>
        <legend className={base.label}>{t('ai.deckTypes')}</legend>
        {QUESTION_TYPES.map((type) => (
          <label key={type} className={styles.check}>
            <input
              type="checkbox"
              checked={settings.types.includes(type)}
              disabled={settings.types.length === 1 && settings.types.includes(type)}
              onChange={(e) => toggleType(type, e.target.checked)}
            />
            <span>
              {type === 'qa' ? t('ai.deckTypeQa') : type === 'cloze' ? t('ai.deckTypeCloze') : t('ai.deckTypeExplain')}
            </span>
          </label>
        ))}
      </fieldset>
      <Segmented<DifficultyMix>
        label={t('ai.deckDifficulty')}
        value={settings.difficulty}
        onChange={(difficulty) => set({ difficulty })}
        options={[
          { value: 'easy', label: t('ai.deckEasy') },
          { value: 'mixed', label: t('ai.deckMixed') },
          { value: 'hard', label: t('ai.deckHard') },
        ]}
      />
      <div className={base.field}>
        <label className={base.label} htmlFor={languageId}>
          {t('ai.deckLanguage')}
        </label>
        <select
          id={languageId}
          className={base.select}
          value={settings.language}
          onChange={(e) => set({ language: e.target.value })}
        >
          <option value="">{t('ai.languageAuto')}</option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code} lang={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <PlacePicker
        value={{ courseId, sectionId: settings.sectionId }}
        onChange={(p) => set({ sectionId: p.sectionId })}
        courseLabel={t('ai.course')}
        sectionLabel={t('ai.deckSaveCardsIn')}
        fixedCourse
      />
    </div>
  )
}

function Progress({
  run,
  units,
  thumbs,
  running,
  preparing,
  kind,
}: {
  run: DeckRun
  units: ReadonlyMap<number, DeckUnit>
  thumbs: ReadonlyMap<number, Thumb>
  running: boolean
  preparing: boolean
  kind: DeckUnit['kind']
}) {
  const t = useT()
  const done = run.units.filter((u) => run.progress.done[u] !== undefined).length
  const total = run.units.length
  const label =
    kind === 'slide'
      ? t('ai.deckProgressSlides', { done, total })
      : kind === 'section'
        ? t('ai.deckProgressSections', { done, total })
        : t('ai.deckProgressPages', { done, total })
  return (
    <section className={base.tight} aria-labelledby="deck-progress">
      <h2 id="deck-progress" className={base.heading}>
        {t('ai.deckProgressTitle')}
      </h2>
      <p className={base.hint} role="status" data-testid="deck-progress">
        {preparing ? t('ai.deckPreparing') : label}
      </p>
      <progress className={styles.bar} max={Math.max(1, total)} value={done} aria-label={label} />
      {(running || done < total) && (
        <ol className={styles.progress}>
          {run.units.map((index) => {
            const u = units.get(index)
            if (!u) return null
            const list = run.progress.done[index]
            const thumb = thumbs.get(index)
            return (
              <li key={index} className={styles.step} data-done={list !== undefined ? 'true' : undefined}>
                <span className={styles.stepThumb} aria-hidden="true">
                  {thumb ? <img src={thumb.url} alt="" /> : <span>{u.label === '0' ? '' : u.label}</span>}
                </span>
                <span className={styles.stepName}>
                  {unitName(t, u)}
                  {u.title && <span className={styles.stepTitle}> · {u.title}</span>}
                </span>
                <span className={styles.stepStatus}>
                  {list !== undefined
                    ? t('ai.deckUnitDone', { count: list.length })
                    : running
                      ? t('ai.deckUnitWaiting')
                      : t('ai.deckUnitNotDone')}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
