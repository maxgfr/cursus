import { useState } from 'react'
import { paths } from '../../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../../app/workspaceContext.tsx'
import type { Rating } from '../../../core/contracts/workspace'
import {
  type ButtonWaits,
  formatSteps,
  type LeechAction,
  type NewMix,
  type NewOrder,
  parseSteps,
  previewSamples,
  REVIEW_DEFAULTS,
  REVIEW_RANGES,
  REVIEW_SETTING_KEYS,
  type ReviewSettings,
  sameSetting,
  srsParamsOf,
} from '../../../core/srs/settings'
import { intlTag } from '../../../i18n/index.ts'
import { useLocale, useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { Segmented } from '../../../ui/components/Segmented.tsx'
import { SwitchRow } from '../../../ui/components/Switch.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import { formatInterval } from '../../Review/interval.ts'
import styles from '../Sync/settings.module.css'

/** The form as typed: numbers and steps as text until they are read. */
interface Form {
  dailyNewCards: string
  maxReviewsPerDay: string
  retention: string
  learningSteps: string
  relearningSteps: string
  maximumInterval: string
  enableFuzz: boolean
  newOrder: NewOrder
  newMix: NewMix
  leechThreshold: string
  leechAction: LeechAction
}

function formOf(s: ReviewSettings): Form {
  return {
    dailyNewCards: String(s.dailyNewCards),
    maxReviewsPerDay: s.maxReviewsPerDay === null ? '' : String(s.maxReviewsPerDay),
    retention: String(Math.round(s.desiredRetention * 100)),
    learningSteps: formatSteps(s.learningSteps),
    relearningSteps: formatSteps(s.relearningSteps),
    maximumInterval: String(s.maximumInterval),
    enableFuzz: s.enableFuzz,
    newOrder: s.newOrder,
    newMix: s.newMix,
    leechThreshold: String(s.leechThreshold),
    leechAction: s.leechAction,
  }
}

/** A whole number within `range`, or null. */
function whole(text: string, range: { min: number; max: number }): number | null {
  const n = Number(text.trim())
  return text.trim() !== '' && Number.isInteger(n) && n >= range.min && n <= range.max ? n : null
}

/** The settings the form says, each one null where what is typed is not a value it takes. */
function read(f: Form): { [K in keyof ReviewSettings]: ReviewSettings[K] | null } & { maxReviewsOk: boolean } {
  const retention = Number(f.retention.trim())
  const r = REVIEW_RANGES.desiredRetention
  const percentOk =
    f.retention.trim() !== '' && Number.isFinite(retention) && retention >= r.min * 100 && retention <= r.max * 100
  const noLimit = f.maxReviewsPerDay.trim() === ''
  const maxReviews = noLimit ? null : whole(f.maxReviewsPerDay, REVIEW_RANGES.maxReviewsPerDay)
  return {
    dailyNewCards: whole(f.dailyNewCards, REVIEW_RANGES.dailyNewCards),
    maxReviewsPerDay: maxReviews,
    maxReviewsOk: noLimit || maxReviews !== null,
    desiredRetention: percentOk ? Math.round(retention) / 100 : null,
    learningSteps: parseSteps(f.learningSteps),
    relearningSteps: parseSteps(f.relearningSteps),
    maximumInterval: whole(f.maximumInterval, REVIEW_RANGES.maximumInterval),
    enableFuzz: f.enableFuzz,
    newOrder: f.newOrder,
    newMix: f.newMix,
    leechThreshold: whole(f.leechThreshold, REVIEW_RANGES.leechThreshold),
    leechAction: f.leechAction,
  }
}

const RATINGS: readonly Rating[] = [1, 2, 3, 4]
const GRADE_KEY = { 1: 'review.again', 2: 'review.hard', 3: 'review.good', 4: 'review.easy' } as const

/**
 * « Schedule »: how reviews are scheduled and queued, for all the cards, Anki-style (FSRS): daily limits, the
 * memory target, the learning steps, new cards, hard cards, and the rest under Advanced. The buttons' waits on two
 * sample cards follow what is typed. The recommended settings are the defaults: nothing is written until Save, and
 * then only what changed (a setting put back to its recommended value gives its key up).
 */
export default function ReviewPrefsSettings() {
  const t = useT()
  const locale = useLocale()
  const ws = useWorkspace()
  const current = useWorkspaceData(['prefs'], (w) => w.reviewSettings.get())
  const [form, setForm] = useState<Form>(() => formOf(current))
  const [note, setNote] = useState<'saved' | 'restored' | null>(null)
  const change = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }))
    setNote(null)
  }

  const typed = read(form)
  const valid = REVIEW_SETTING_KEYS.every((k) => k === 'maxReviewsPerDay' || typed[k] !== null) && typed.maxReviewsOk
  const patch: Partial<ReviewSettings> = {}
  if (valid) {
    const target = patch as Record<string, unknown>
    for (const k of REVIEW_SETTING_KEYS) if (!sameSetting(k, typed[k], current[k])) target[k] = typed[k]
  }
  const changed = Object.keys(patch).length > 0
  const recommended = REVIEW_SETTING_KEYS.every((k) => sameSetting(k, typed[k], REVIEW_DEFAULTS[k]))

  // The waits on the sample cards, with what is typed where it is valid, the saved settings elsewhere.
  const preview = previewSamples(
    srsParamsOf({
      desiredRetention: typed.desiredRetention ?? current.desiredRetention,
      learningSteps: typed.learningSteps ?? current.learningSteps,
      relearningSteps: typed.relearningSteps ?? current.relearningSteps,
      maximumInterval: typed.maximumInterval ?? current.maximumInterval,
      enableFuzz: false,
    }),
    Date.now(),
  )
  const tag = intlTag(locale)
  const waits = (w: ButtonWaits) => RATINGS.map((r) => `${t(GRADE_KEY[r])} ${formatInterval(w[r], tag)}`).join(' · ')

  const stepsError = t('settings.stepsError')
  return (
    <Screen title={t('common.setReview')} back={paths.settings}>
      <form
        className={styles.stack}
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid || !changed) return
          ws.reviewSettings.set(patch)
          setNote('saved')
        }}
      >
        <p className={styles.prose}>{t('common.reviewPrefsBody')}</p>

        <section className={styles.card} aria-labelledby="review-preview">
          <h2 id="review-preview" className={styles.sectionTitle}>
            {t('settings.reviewPreview')}
          </h2>
          <dl className={styles.facts} data-testid="review-preview">
            <dt>{t('settings.previewNew')}</dt>
            <dd>{waits(preview.fresh)}</dd>
            <dt>{t('settings.previewReview')}</dt>
            <dd>{waits(preview.review)}</dd>
          </dl>
        </section>

        <section className={styles.card} aria-labelledby="review-limits">
          <h2 id="review-limits" className={styles.sectionTitle}>
            {t('settings.reviewLimits')}
          </h2>
          <Field
            label={t('settings.dailyNew')}
            hint={t('settings.dailyNewHint')}
            type="number"
            inputMode="numeric"
            min={REVIEW_RANGES.dailyNewCards.min}
            max={REVIEW_RANGES.dailyNewCards.max}
            step={1}
            value={form.dailyNewCards}
            onChange={(e) => change({ dailyNewCards: e.target.value })}
            error={typed.dailyNewCards === null ? t('settings.dailyNewError') : undefined}
          />
          <Field
            label={t('settings.dailyMax')}
            hint={t('settings.dailyMaxHint')}
            type="number"
            inputMode="numeric"
            min={REVIEW_RANGES.maxReviewsPerDay.min}
            max={REVIEW_RANGES.maxReviewsPerDay.max}
            step={1}
            placeholder={t('settings.noLimit')}
            value={form.maxReviewsPerDay}
            onChange={(e) => change({ maxReviewsPerDay: e.target.value })}
            error={typed.maxReviewsOk ? undefined : t('settings.dailyMaxError')}
          />
        </section>

        <section className={styles.card} aria-labelledby="review-memory">
          <h2 id="review-memory" className={styles.sectionTitle}>
            {t('settings.reviewMemory')}
          </h2>
          <Field
            label={t('settings.retentionPercent')}
            hint={t('settings.retentionHint')}
            type="number"
            inputMode="numeric"
            min={REVIEW_RANGES.desiredRetention.min * 100}
            max={REVIEW_RANGES.desiredRetention.max * 100}
            step={1}
            value={form.retention}
            onChange={(e) => change({ retention: e.target.value })}
            error={
              typed.desiredRetention === null
                ? t('settings.retentionError', {
                    min: REVIEW_RANGES.desiredRetention.min * 100,
                    max: REVIEW_RANGES.desiredRetention.max * 100,
                  })
                : undefined
            }
          />
        </section>

        <section className={styles.card} aria-labelledby="review-steps">
          <h2 id="review-steps" className={styles.sectionTitle}>
            {t('settings.reviewSteps')}
          </h2>
          <Field
            label={t('settings.learningSteps')}
            hint={t('settings.learningStepsHint')}
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            value={form.learningSteps}
            onChange={(e) => change({ learningSteps: e.target.value })}
            error={typed.learningSteps === null ? stepsError : undefined}
          />
          <Field
            label={t('settings.relearningSteps')}
            hint={t('settings.relearningStepsHint')}
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            value={form.relearningSteps}
            onChange={(e) => change({ relearningSteps: e.target.value })}
            error={typed.relearningSteps === null ? stepsError : undefined}
          />
        </section>

        <section className={styles.card} aria-labelledby="review-new">
          <h2 id="review-new" className={styles.sectionTitle}>
            {t('settings.reviewNewCards')}
          </h2>
          <Segmented<NewOrder>
            label={t('settings.newOrder')}
            value={form.newOrder}
            onChange={(newOrder) => change({ newOrder })}
            options={[
              { value: 'created', label: t('settings.newOrderCreated') },
              { value: 'random', label: t('settings.newOrderRandom') },
            ]}
          />
          <Segmented<NewMix>
            label={t('settings.newMix')}
            value={form.newMix}
            onChange={(newMix) => change({ newMix })}
            options={[
              { value: 'after', label: t('settings.newMixAfter') },
              { value: 'mixed', label: t('settings.newMixMixed') },
              { value: 'before', label: t('settings.newMixBefore') },
            ]}
          />
        </section>

        <section className={styles.card} aria-labelledby="review-leeches">
          <h2 id="review-leeches" className={styles.sectionTitle}>
            {t('settings.reviewLeeches')}
          </h2>
          <Field
            label={t('settings.leechThreshold')}
            hint={t('settings.leechThresholdHint')}
            type="number"
            inputMode="numeric"
            min={REVIEW_RANGES.leechThreshold.min}
            max={REVIEW_RANGES.leechThreshold.max}
            step={1}
            value={form.leechThreshold}
            onChange={(e) => change({ leechThreshold: e.target.value })}
            error={typed.leechThreshold === null ? t('settings.leechThresholdError') : undefined}
          />
          <Segmented<LeechAction>
            label={t('settings.leechAction')}
            value={form.leechAction}
            onChange={(leechAction) => change({ leechAction })}
            options={[
              { value: 'flag', label: t('settings.leechFlag') },
              { value: 'suspend', label: t('settings.leechSuspend') },
            ]}
          />
        </section>

        <details className={styles.advanced}>
          <summary>{t('sync.advanced')}</summary>
          <div className={styles.card}>
            <Field
              label={t('settings.maximumInterval')}
              hint={t('settings.maximumIntervalHint')}
              type="number"
              inputMode="numeric"
              min={REVIEW_RANGES.maximumInterval.min}
              max={REVIEW_RANGES.maximumInterval.max}
              step={1}
              value={form.maximumInterval}
              onChange={(e) => change({ maximumInterval: e.target.value })}
              error={typed.maximumInterval === null ? t('settings.maximumIntervalError') : undefined}
            />
            <SwitchRow
              label={t('settings.enableFuzz')}
              hint={t('settings.enableFuzzHint')}
              checked={form.enableFuzz}
              onChange={(enableFuzz) => change({ enableFuzz })}
            />
          </div>
        </details>

        {note !== null && (
          <p className={styles.ok} role="status">
            {note === 'saved' ? t('settings.saved') : t('settings.restored')}
          </p>
        )}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={!changed || !valid}>
            {t('common.save')}
          </Button>
          <Button
            disabled={recommended}
            onClick={() => {
              setForm(formOf({ ...REVIEW_DEFAULTS }))
              setNote('restored')
            }}
          >
            {t('settings.restoreRecommended')}
          </Button>
        </div>
      </form>
    </Screen>
  )
}
