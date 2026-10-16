import { Sparkles, WifiOff } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useRuntime, useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { JobOptions } from '../../core/ai/autoQuestions'
import { type DifficultyMix, QUESTION_TYPES, type QuestionType } from '../../core/ai/features/deckQuestions'
import { supportsImages } from '../../core/ai/features/readDeck'
import type { DeckUnit } from '../../core/content/deck'
import type { Id, StudyScope } from '../../core/contracts/workspace'
import type { SourceRecord } from '../../core/model/schema'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { autoQuestions } from '../../ui/data/autoQuestions.ts'
import { useOnline } from '../../ui/ExplainLauncher.tsx'
import { deckErrorMessage, type LoadedDeck, loadDeck, unitName } from '../DeckImport/deckSource.ts'
import { scopeOptions, scopeValue } from '../SessionSetup/draft.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import shared from '../Understand/shared/ai.module.css'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import styles from './Generate.module.css'

/** Where « Create cards » opens: a course or section, and the sources picked there (all of them by default). */
export interface GenerateAt {
  courseId?: Id
  sectionId?: Id
  sourceIds?: readonly Id[]
}

const PER_UNIT = ['auto', '1', '2', '3', '5'] as const
type PerUnit = (typeof PER_UNIT)[number]
const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
] as const

const isDeck = (s: Pick<SourceRecord, 'kind' | 'support'>) => s.kind === 'pdf' || s.support !== undefined
/** The choices that hold for every source: the units are those of the one deck chosen. */
const general = ({ units: _units, hidden: _hidden, ...rest }: JobOptions): JobOptions => rest

interface Range {
  from: number
  to: number
  hidden: boolean
}

/**
 * « Create cards »: the course or section, its sources (some of them only if wished), for one slide deck or document
 * the slides or sections to read, how many cards per unit, their kinds, difficulty and language, and what it would
 * cost. Create queues one job per source and opens « Suggested cards », where they arrive and are reviewed.
 */
export default function GenerateSheet({ at, onClose }: { at: GenerateAt; onClose: () => void }) {
  const t = useT()
  return (
    <Sheet open title={t('ai.deckQuestionsTitle')} onClose={onClose}>
      <GenerateForm at={at} onDone={onClose} />
    </Sheet>
  )
}

function GenerateForm({ at, onDone }: { at: GenerateAt; onDone: () => void }) {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const ws = useWorkspace()
  const [, navigate] = useLocation()
  const ai = useAiModel()
  const online = useOnline()
  const placeId = useId()
  const fromId = useId()
  const toId = useId()
  const languageId = useId()
  const places = useWorkspaceData(['courses', 'sections'], (w) =>
    scopeOptions(w).flatMap((o) =>
      o.scope.courseId === undefined
        ? []
        : [
            {
              value: o.value,
              label: o.label,
              scope: (o.scope.sectionId
                ? { courseId: o.scope.courseId, sectionId: o.scope.sectionId }
                : { courseId: o.scope.courseId }) as StudyScope,
            },
          ],
    ),
  )
  // Opened on a source: its own place, else the place given, else the first course.
  const [place, setPlace] = useState<string>(() => {
    const first = at.sourceIds?.[0] === undefined ? undefined : ws.sources.get(at.sourceIds[0])
    const sectionId = first ? ws.sections.tree().sectionOf(first) : null
    const scope: StudyScope | undefined = first
      ? sectionId === null
        ? { courseId: first.courseId }
        : { courseId: first.courseId, sectionId }
      : at.courseId
        ? at.sectionId
          ? { courseId: at.courseId, sectionId: at.sectionId }
          : { courseId: at.courseId }
        : undefined
    return scope ? scopeValue(scope) : (places[0]?.value ?? '')
  })
  const current = places.find((p) => p.value === place)
  const sources = useWorkspaceData(['sources', 'sections', { id: place }], (w) =>
    current ? w.scoped('sources', current.scope) : [],
  )
  const [picked, setPicked] = useState<readonly Id[] | null>(at.sourceIds ?? null)
  const chosen = (picked ?? sources.map((s) => s.id)).filter((id) => sources.some((s) => s.id === id))
  const single = chosen.length === 1 ? sources.find((s) => s.id === chosen[0]) : undefined
  const deckSource = single && isDeck(single) ? single : undefined

  const [perUnit, setPerUnit] = useState<PerUnit>('auto')
  const [types, setTypes] = useState<readonly QuestionType[]>(['qa', 'cloze'])
  const [difficulty, setDifficulty] = useState<DifficultyMix>('mixed')
  const [language, setLanguage] = useState('')
  const [range, setRange] = useState<Range | null>(null)
  const [deck, setDeck] = useState<LoadedDeck | null>(null)
  const [deckError, setDeckError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // One deck or document chosen: its slides or sections, to read only some of them.
  useEffect(() => {
    setDeck(null)
    setRange(null)
    setDeckError(null)
    if (!deckSource) return
    let live = true
    loadDeck(rt, deckSource).then(
      (l) => {
        if (!live) return
        setDeck(l)
        setRange({ from: l.deck.units[0]?.index ?? 1, to: l.deck.units.at(-1)?.index ?? 1, hidden: false })
      },
      (e: unknown) => {
        noteError('generate.deck', e)
        if (live) setDeckError(deckErrorMessage(t, e))
      },
    )
    return () => {
      live = false
    }
  }, [rt, deckSource, t])

  const deckUnits = useMemo((): readonly DeckUnit[] => deck?.deck.units ?? [], [deck])
  const inRange = range ? deckUnits.filter((u) => u.index >= range.from && u.index <= range.to) : []
  const selected = inRange.filter((u) => range?.hidden === true || !u.hidden)
  const kind = deckUnits[0]?.kind

  const options = useMemo(() => {
    const o: JobOptions = { perUnit: perUnit === 'auto' ? 'auto' : Number(perUnit), types: [...types], difficulty }
    if (language !== '') o.language = language
    if (range) {
      o.units = deckUnits
        .filter((u) => u.index >= range.from && u.index <= range.to && (range.hidden || !u.hidden))
        .map((u) => u.index)
      if (range.hidden) o.hidden = true
    }
    return o
  }, [perUnit, types, difficulty, language, range, deckUnits])
  const deckId = deckSource?.id
  const optionsFor = (id: Id): JobOptions => (id === deckId ? options : general(options))

  // What it would cost, worked out by the queue itself (a deck is read for it).
  const [estimate, setEstimate] = useState<{ cost: number; units: number } | null>(null)
  const chosenKey = chosen.join(',')
  const waitingRange = deckSource !== undefined && range === null
  const ready = ai.status === 'ready'
  useEffect(() => {
    setEstimate(null)
    const ids = chosenKey === '' ? [] : chosenKey.split(',')
    if (!ready || ids.length === 0 || waitingRange) return
    let live = true
    const timer = setTimeout(() => {
      autoQuestions(rt)
        .then((q) => Promise.all(ids.map((id) => q.estimate(id, id === deckId ? options : general(options)))))
        .then(
          (all) => {
            if (!live) return
            let cost = 0
            let units = 0
            for (const e of all) {
              if (e.kind !== 'ok') continue
              cost += e.estimate.cost
              units += e.estimate.units
            }
            setEstimate({ cost, units })
          },
          (e: unknown) => noteError('generate.estimate', e),
        )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [chosenKey, options, deckId, waitingRange, ready, rt])

  if (ai.status !== 'ready') return null
  if (places.length === 0) return <p className={shared.hint}>{t('ai.quizNoSources')}</p>
  const canRun = online || ai.runsOffline
  const textOnly = !supportsImages(ai.info) && chosen.some((id) => sources.find((s) => s.id === id && isDeck(s)))
  const unitsLabel = (count: number) =>
    kind === 'slide' && deckSource
      ? t('ai.deckSlides', { count })
      : kind === 'page' && deckSource
        ? t('ai.deckPages', { count })
        : t('ai.deckSections', { count })
  const perUnitLabel = !deckSource
    ? t('ai.generatePerUnit')
    : kind === 'slide'
      ? t('ai.deckPerSlide')
      : kind === 'page'
        ? t('ai.deckPerPage')
        : t('ai.deckPerSection')
  const option = (u: DeckUnit) => (u.title ? `${unitName(t, u)} · ${u.title}` : unitName(t, u))
  const toggleType = (type: QuestionType, on: boolean) => {
    const next = QUESTION_TYPES.filter((q) => (q === type ? on : types.includes(q)))
    if (next.length > 0) setTypes(next)
  }
  const hiddenInRange = inRange.filter((u) => u.hidden).length

  const create = async () => {
    setError(null)
    try {
      const q = await autoQuestions(rt)
      for (const id of chosen) await q.enqueue(id, optionsFor(id))
      onDone()
      navigate(paths.inbox)
    } catch (e) {
      noteError('generate.enqueue', e)
      setError(t('ai.failed', { reason: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <form
      className={shared.stack}
      onSubmit={(e) => {
        e.preventDefault()
        void create()
      }}
    >
      <div className={shared.field}>
        <label className={shared.label} htmlFor={placeId}>
          {t('ai.quizNode')}
        </label>
        <select
          id={placeId}
          className={shared.select}
          value={place}
          onChange={(e) => {
            setPlace(e.target.value)
            setPicked(null)
          }}
        >
          {places.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      {sources.length === 0 && <p className={shared.hint}>{t('ai.generateNoSource')}</p>}
      {sources.length > 1 && (
        <details className={shared.disclosure} open={at.sourceIds !== undefined}>
          <summary className={shared.disclosureSummary}>
            <span className={shared.disclosureLabel}>
              {t('ai.quizSourcesChosen', { count: chosen.length, total: sources.length })}
            </span>
          </summary>
          <div className={shared.disclosureBody}>
            {sources.map((s) => (
              <label key={s.id} className={shared.check}>
                <input
                  type="checkbox"
                  checked={chosen.includes(s.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...chosen, s.id] : chosen.filter((id) => id !== s.id))}
                />
                {s.title}
              </label>
            ))}
          </div>
        </details>
      )}
      {deckError !== null && (
        <p className={shared.error} role="alert">
          {deckError}
        </p>
      )}
      {range && deckUnits.length > 1 && (
        <fieldset className={shared.fieldset}>
          <legend className={shared.label}>{t('ai.deckRange')}</legend>
          <div className={styles.range}>
            <div className={shared.field}>
              <label className={shared.label} htmlFor={fromId}>
                {t('ai.deckFrom')}
              </label>
              <select
                id={fromId}
                className={shared.select}
                value={range.from}
                onChange={(e) => {
                  const from = Number(e.target.value)
                  setRange({ ...range, from, to: Math.max(from, range.to) })
                }}
              >
                {deckUnits.map((u) => (
                  <option key={u.index} value={u.index}>
                    {option(u)}
                  </option>
                ))}
              </select>
            </div>
            <div className={shared.field}>
              <label className={shared.label} htmlFor={toId}>
                {t('ai.deckTo')}
              </label>
              <select
                id={toId}
                className={shared.select}
                value={range.to}
                onChange={(e) => {
                  const to = Number(e.target.value)
                  setRange({ ...range, to, from: Math.min(to, range.from) })
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
          {hiddenInRange > 0 && (
            <label className={shared.check}>
              <input
                type="checkbox"
                checked={range.hidden}
                onChange={(e) => setRange({ ...range, hidden: e.target.checked })}
              />
              {t('ai.deckIncludeHidden', { count: hiddenInRange })}
            </label>
          )}
          <p className={shared.hint}>{t('ai.deckSelected', { count: selected.length })}</p>
        </fieldset>
      )}
      <Segmented<PerUnit>
        label={perUnitLabel}
        value={perUnit}
        onChange={setPerUnit}
        options={PER_UNIT.map((n) => ({ value: n, label: n === 'auto' ? t('ai.generateAuto') : n }))}
      />
      <fieldset className={shared.fieldset}>
        <legend className={shared.label}>{t('ai.deckTypes')}</legend>
        {QUESTION_TYPES.map((type) => (
          <label key={type} className={shared.check}>
            <input
              type="checkbox"
              checked={types.includes(type)}
              disabled={types.length === 1 && types.includes(type)}
              onChange={(e) => toggleType(type, e.target.checked)}
            />
            {type === 'qa' ? t('ai.deckTypeQa') : type === 'cloze' ? t('ai.deckTypeCloze') : t('ai.deckTypeExplain')}
          </label>
        ))}
      </fieldset>
      <Segmented<DifficultyMix>
        label={t('ai.deckDifficulty')}
        value={difficulty}
        onChange={setDifficulty}
        options={[
          { value: 'easy', label: t('ai.deckEasy') },
          { value: 'mixed', label: t('ai.deckMixed') },
          { value: 'hard', label: t('ai.deckHard') },
        ]}
      />
      <div className={shared.field}>
        <label className={shared.label} htmlFor={languageId}>
          {t('ai.deckLanguage')}
        </label>
        <select
          id={languageId}
          className={shared.select}
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value="">{t('ai.languageAuto')}</option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code} lang={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      {estimate !== null && (
        <p className={shared.hint} data-testid="deck-estimate">
          {t('ai.cost', { amount: formatUsd(locale, estimate.cost) })} · {unitsLabel(estimate.units)} · {ai.info.name}
        </p>
      )}
      {textOnly && (
        <p className={styles.notice} role="note">
          {t('ai.deckTextOnly')}
        </p>
      )}
      {!canRun && (
        <p className={styles.notice} role="status">
          <WifiOff size={18} aria-hidden="true" />
          {t('ai.deckOffline')}
        </p>
      )}
      {error !== null && (
        <p className={shared.error} role="alert">
          {error}
        </p>
      )}
      <div className={shared.row}>
        <Button
          type="submit"
          variant="primary"
          icon={<Sparkles size={18} aria-hidden="true" />}
          disabled={!canRun || chosen.length === 0 || (deckSource !== undefined && selected.length === 0)}
        >
          {t('ai.deckRun')}
        </Button>
      </div>
    </form>
  )
}
