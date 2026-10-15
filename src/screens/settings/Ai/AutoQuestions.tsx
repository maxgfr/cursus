import { useId, useMemo, useState } from 'react'
import { useRuntime, useWorkspaceData } from '../../../app/workspaceContext.tsx'
import type { StudyScope } from '../../../core/contracts/workspace'
import {
  AUTO_QUESTION_MAX_PER_UNIT,
  type AutoQuestionDifficulty,
  type AutoQuestionLanguage,
  type AutoQuestionMode,
  type AutoQuestionSettings,
} from '../../../core/model/drafts'
import type { DraftQuestionType } from '../../../core/model/schema'
import { formatUsd } from '../../../i18n/format.ts'
import { useLocale, useT } from '../../../i18n/react.tsx'
import { Segmented } from '../../../ui/components/Segmented.tsx'
import { resumeAutoQuestions } from '../../../ui/data/autoQuestions.ts'
import shared from '../../Understand/shared/ai.module.css'
import styles from './AutoQuestions.module.css'

const TYPES: readonly DraftQuestionType[] = ['qa', 'cloze', 'explain']
const PER_UNIT = Array.from({ length: AUTO_QUESTION_MAX_PER_UNIT }, (_, i) => i + 1)

/** A cost cap as typed: a number of dollars, 0 or more (comma or point). */
function parseCap(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'))
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null
}

/** A cap field: saved when it loses focus or on Return, the queue then looks again at documents over a cap. */
function CapField({ label, value, onSave }: { label: string; value: number; onSave: (n: number) => void }) {
  const t = useT()
  const id = useId()
  const [text, setText] = useState(String(value))
  const [shown, setShown] = useState(value)
  // Changed elsewhere (another device): the field follows unless it is being edited to the same value.
  if (shown !== value) {
    setShown(value)
    setText(String(value))
  }
  const parsed = parseCap(text)
  const commit = () => {
    if (parsed !== null && parsed !== value) onSave(parsed)
  }
  return (
    <div className={shared.field}>
      <label className={shared.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={styles.cap}
        inputMode="decimal"
        value={text}
        aria-invalid={parsed === null ? true : undefined}
        aria-describedby={parsed === null ? `${id}-error` : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      {parsed === null && (
        <p id={`${id}-error`} className={shared.error} role="alert">
          {t('ai.autoCapInvalid')}
        </p>
      )}
    </div>
  )
}

/**
 * « When I add a document »: the one visible choice (propose questions, add them directly, do nothing), and
 * the rest folded under Advanced: questions per unit, kinds, difficulty, language, duplicates, destination and
 * the cost caps with this month's spending. Synced: the same everywhere.
 */
export function AutoQuestions({ monthCost }: { monthCost: number }) {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const perUnitId = useId()
  const languageId = useId()
  const destinationId = useId()
  const settings = useWorkspaceData(['prefs'], (ws) => ws.drafts.settings.get())
  const places = useWorkspaceData(['courses', 'sections'], (ws) => {
    const tree = ws.sections.tree()
    const out: { scope: StudyScope; label: string }[] = []
    for (const c of ws.courses.list()) {
      out.push({ scope: { courseId: c.id }, label: c.title })
      const visit = (parentId: string | null, prefix: string) => {
        for (const s of tree.children(c.id, parentId)) {
          const label = `${prefix} › ${s.name}`
          out.push({ scope: { courseId: c.id, sectionId: s.id }, label })
          visit(s.id, label)
        }
      }
      visit(null, c.title)
    }
    return out
  })
  const set = (patch: Partial<AutoQuestionSettings>) => rt.ws.drafts.settings.set(patch)
  const setCaps = (patch: Pick<Partial<AutoQuestionSettings>, 'capPerDocument' | 'capPerMonth'>) => {
    set(patch)
    void resumeAutoQuestions(rt, { overCap: true })
  }
  const destination = settings.destination
  const destinationIndex = useMemo(
    () =>
      destination === undefined
        ? -1
        : places.findIndex(
            (p) => p.scope.courseId === destination.courseId && p.scope.sectionId === destination.sectionId,
          ),
    [places, destination],
  )
  const modeHint: Record<AutoQuestionMode, string> = {
    propose: t('ai.autoProposeHint'),
    add: t('ai.autoAddHint'),
    off: t('ai.autoOffHint'),
  }
  const toggleType = (type: DraftQuestionType, on: boolean) => {
    const next = on
      ? TYPES.filter((x) => x === type || settings.types.includes(x))
      : settings.types.filter((x) => x !== type)
    if (next.length > 0) set({ types: next })
  }

  return (
    <section className={styles.section} aria-labelledby="auto-questions-h">
      <h2 id="auto-questions-h" className={shared.heading}>
        {t('ai.autoHeading')}
      </h2>
      <Segmented<AutoQuestionMode>
        label={t('ai.autoTitle')}
        value={settings.mode}
        onChange={(mode) => set({ mode })}
        options={[
          { value: 'propose', label: t('ai.autoPropose') },
          { value: 'add', label: t('ai.autoAdd') },
          { value: 'off', label: t('ai.autoOff') },
        ]}
      />
      <p className={shared.hint}>{modeHint[settings.mode]}</p>
      <details className={styles.advanced}>
        <summary className={styles.summary}>{t('ai.autoAdvanced')}</summary>
        <div className={styles.fields}>
          <div className={shared.field}>
            <label className={shared.label} htmlFor={perUnitId}>
              {t('ai.autoPerUnit')}
            </label>
            <select
              id={perUnitId}
              className={shared.select}
              value={settings.perUnit}
              onChange={(e) => set({ perUnit: Number(e.target.value) })}
            >
              {PER_UNIT.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <fieldset className={shared.fieldset}>
            <legend className={shared.label}>{t('ai.deckTypes')}</legend>
            <div className={shared.row}>
              {TYPES.map((type) => {
                const on = settings.types.includes(type)
                return (
                  <label key={type} className={shared.check}>
                    <input
                      type="checkbox"
                      checked={on}
                      // At least one kind stays chosen.
                      disabled={on && settings.types.length === 1}
                      onChange={(e) => toggleType(type, e.target.checked)}
                    />
                    {type === 'qa'
                      ? t('ai.deckTypeQa')
                      : type === 'cloze'
                        ? t('ai.deckTypeCloze')
                        : t('ai.deckTypeExplain')}
                  </label>
                )
              })}
            </div>
          </fieldset>
          <Segmented<AutoQuestionDifficulty>
            label={t('ai.deckDifficulty')}
            value={settings.difficulty}
            onChange={(difficulty) => set({ difficulty })}
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
              value={settings.language}
              onChange={(e) => set({ language: e.target.value as AutoQuestionLanguage })}
            >
              <option value="course">{t('ai.autoLanguageCourse')}</option>
              <option value="en" lang="en">
                English
              </option>
              <option value="de" lang="de">
                Deutsch
              </option>
              <option value="fr" lang="fr">
                Français
              </option>
            </select>
          </div>
          <label className={shared.check}>
            <input type="checkbox" checked={settings.dedupe} onChange={(e) => set({ dedupe: e.target.checked })} />
            {t('ai.autoDedupe')}
          </label>
          <div className={shared.field}>
            <label className={shared.label} htmlFor={destinationId}>
              {t('ai.deckSaveCardsIn')}
            </label>
            <select
              id={destinationId}
              className={shared.select}
              value={destinationIndex}
              onChange={(e) => {
                const place = places[Number(e.target.value)]
                set({ destination: place?.scope })
              }}
            >
              <option value={-1}>{t('ai.autoDestinationOwn')}</option>
              {places.map((p, i) => (
                <option key={`${p.scope.courseId}/${p.scope.sectionId ?? ''}`} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.caps}>
            <CapField
              label={t('ai.autoCapDocument')}
              value={settings.capPerDocument}
              onSave={(capPerDocument) => setCaps({ capPerDocument })}
            />
            <CapField
              label={t('ai.autoCapMonth')}
              value={settings.capPerMonth}
              onSave={(capPerMonth) => setCaps({ capPerMonth })}
            />
          </div>
          <p className={shared.hint}>
            {t('ai.autoCapHint')} {t('ai.autoMonthSpent', { cost: formatUsd(locale, monthCost) })}
          </p>
        </div>
      </details>
    </section>
  )
}
