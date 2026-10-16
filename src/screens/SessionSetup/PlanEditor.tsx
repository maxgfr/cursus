import { CalendarPlus, Play, Trash2 } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useLocation, useParams } from 'wouter'
import { goBack } from '../../app/nav.ts'
import { paths, to } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id, SessionScope, Weekday } from '../../core/contracts/workspace'
import type { PlanFields, PlanRecord } from '../../core/model/schema'
import { partSize, planScope, startPlan } from '../../core/model/sessions'
import { EXAM_SIZE } from '../../core/srs/exam'
import { intlTag } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import NotFound from '../NotFound/index.tsx'
import { useScopeOnce } from '../Section/scope.ts'
import { downloadPlans } from '../Sessions/calendar.ts'
import { planLabel } from '../Sessions/describe.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { liveScope, scopeOptions } from './draft.ts'
import { ScopeField } from './SessionFields.tsx'
import styles from './SessionSetup.module.css'

const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7]
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const DEFAULT_TIME = '18:00'
/** The batch sizes offered, every ten cards from the smallest to the largest. */
const SIZES = ['50', '60', '70', '80'] as const
type Size = (typeof SIZES)[number]

/** A plan's batch size as one of those offered (an older plan's limit, the nearest one). */
function sizeOf(limit: number | undefined): Size {
  const n = Math.min(EXAM_SIZE.max, Math.max(EXAM_SIZE.min, Math.round((limit ?? EXAM_SIZE.default) / 10) * 10))
  return SIZES.find((s) => Number(s) === n) ?? '60'
}

/** History state the editor leaves the sessions screen: a plan to undo the deletion of, or a calm "planned". */
export interface PlanNotice {
  trashedPlan?: Id
  planSaved?: boolean
}

/**
 * A planned session's editor (`/sessions/plan/new` creates one). Every plan saved here is an exam: a part of a course,
 * a batch of cards drawn from it each time, gone over until every one is known.
 */
export default function PlanEditor() {
  const { id = '' } = useParams<{ id: string }>()
  return <PlanForm key={id} planId={id === 'new' ? null : id} />
}

function PlanForm({ planId }: { planId: Id | null }) {
  const t = useT()
  const ws = useWorkspace()
  const locale = useLocale()
  const [, navigate] = useLocation()
  const asked = useScopeOnce()
  const options = useWorkspaceData(['courses', 'sections'], scopeOptions)
  const plan = useWorkspaceData(['plans'], (w) => (planId === null ? null : (w.plans.get(planId) ?? null)))
  const [name, setName] = useState(() => plan?.name ?? '')
  // A part of a course: every course at once is no part to know by heart.
  const [scope, setScope] = useState<SessionScope>(() => {
    const live = liveScope(options, plan ? planScope(plan) : (asked ?? {}))
    return live.courseId === undefined ? (options[0]?.scope ?? {}) : live
  })
  const [size, setSize] = useState<Size>(() => sizeOf(plan?.limit))
  // A fresh snapshot whenever the cards or the subsets change: the count follows them, and the place picked, live.
  const live = useWorkspaceData(['cards', 'courses', 'sections'], (w) => ({ w }))
  const cards = useMemo(() => partSize(live.w, scope), [live, scope])
  const [days, setDays] = useState<readonly Weekday[]>(() => plan?.weekdays ?? [1, 2, 3, 4, 5])
  const [time, setTime] = useState(() => plan?.time ?? DEFAULT_TIME)
  const [tried, setTried] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const daysId = useId()
  const daysErrorId = useId()

  if (planId !== null && (plan === null || plan.deletedAt !== undefined)) return <NotFound />

  const nameError = name.trim() === '' ? t('review.planNameMissing') : null
  const daysError = days.length === 0 ? t('review.planDaysMissing') : null
  const scopeError = scope.courseId === undefined ? t('review.planScopeMissing') : null
  const timeValid = TIME.test(time)
  const short = new Intl.DateTimeFormat(intlTag(locale), { weekday: 'short', timeZone: 'UTC' })
  const long = new Intl.DateTimeFormat(intlTag(locale), { weekday: 'long', timeZone: 'UTC' })
  const describe = (p: PlanRecord) => planLabel(ws, t, p)

  const save = () => {
    setTried(true)
    if (nameError !== null || daysError !== null || scopeError !== null || !timeValid) return
    // `kind`, `limit` and `practice` are what an older client runs: once over a batch, out of the schedule.
    const fields: PlanFields = {
      name: name.trim(),
      courseId: scope.courseId,
      sectionId: scope.sectionId,
      kind: 'all',
      limit: Number(size),
      weekdays: [...days],
      time,
      practice: true,
      mode: 'exam',
    }
    try {
      if (plan) ws.plans.update(plan.id, fields)
      else ws.plans.create(fields)
      const notice: PlanNotice = { planSaved: true }
      goBack(paths.sessions, { state: notice })
    } catch (e) {
      noteError('session.plan', e)
      setMessage(t('errors.generic'))
    }
  }

  const toggleDay = (d: Weekday, on: boolean) =>
    setDays((now) => (on ? [...now.filter((x) => x !== d), d].sort((a, b) => a - b) : now.filter((x) => x !== d)))

  return (
    <Screen title={plan ? t('review.editPlan') : t('review.newPlan')} back={paths.sessions}>
      <form
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <Field
          label={t('review.planName')}
          placeholder={t('review.planNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={tried && nameError !== null ? nameError : undefined}
          enterKeyHint="next"
          autoComplete="off"
        />
        <p className={styles.hint}>{t('review.examHint')}</p>
        <ScopeField scope={scope} onChange={setScope} part error={tried ? scopeError : null} />
        <div className={styles.field}>
          <Segmented<Size>
            label={t('review.examSize')}
            value={size}
            onChange={setSize}
            options={SIZES.map((s) => ({ value: s, label: s }))}
          />
          <p className={styles.hint} aria-live="polite">
            {cards === 0
              ? t('review.examSizeNone')
              : cards <= Number(size)
                ? t('review.examSizeAll', { count: cards })
                : t('review.examSizeMore', { total: cards, size })}
          </p>
        </div>
        <fieldset className={styles.days} aria-describedby={tried && daysError !== null ? daysErrorId : undefined}>
          <legend className={styles.label}>{t('review.planDays')}</legend>
          <div className={styles.dayTrack}>
            {WEEKDAYS.map((d) => {
              const inputId = `${daysId}-${d}`
              const date = Date.UTC(2024, 0, d, 12)
              return (
                <span key={d} className={styles.day}>
                  <input
                    id={inputId}
                    className={styles.dayInput}
                    type="checkbox"
                    checked={days.includes(d)}
                    onChange={(e) => toggleDay(d, e.target.checked)}
                    aria-label={long.format(date)}
                  />
                  <label htmlFor={inputId} className={styles.dayLabel} aria-hidden="true">
                    {short.format(date)}
                  </label>
                </span>
              )
            })}
          </div>
          {tried && daysError !== null && (
            <p id={daysErrorId} className={styles.error} role="alert">
              {daysError}
            </p>
          )}
        </fieldset>
        <Field
          label={t('review.planTime')}
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          error={tried && !timeValid ? t('review.planTimeMissing') : undefined}
          required
        />
        <div className={styles.actions}>
          <Button type="submit" variant="primary" size="large" full>
            {t('review.savePlan')}
          </Button>
        </div>
      </form>
      {plan && (
        <div className={styles.actions}>
          <Button
            icon={<Play size={18} aria-hidden="true" />}
            onClick={() => {
              const sid = startPlan(ws, plan)
              navigate(to.sessionRun(sid), { state: { session: sid } })
            }}
          >
            {t('review.startNow')}
          </Button>
          <Button
            icon={<CalendarPlus size={18} aria-hidden="true" />}
            onClick={() => {
              try {
                downloadPlans([plan], plan.name, describe)
                setMessage(t('review.calendarDone'))
              } catch (e) {
                noteError('session.calendar', e)
                setMessage(t('review.calendarFailed'))
              }
            }}
          >
            {t('review.addToCalendar')}
          </Button>
          <Button
            variant="danger"
            icon={<Trash2 size={18} aria-hidden="true" />}
            onClick={() => {
              ws.plans.trash(plan.id)
              const notice: PlanNotice = { trashedPlan: plan.id }
              goBack(paths.sessions, { state: notice })
            }}
          >
            {t('review.deletePlan')}
          </Button>
        </div>
      )}
      {message !== null && (
        <Toast message={message} actions={[{ label: t('review.dismiss'), onClick: () => setMessage(null) }]} />
      )}
    </Screen>
  )
}
