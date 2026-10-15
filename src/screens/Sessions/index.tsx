import { CalendarPlus, ChartColumn, ListChecks, Play, Plus, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useLocation } from 'wouter'
import { clearEntryState } from '../../app/nav.ts'
import { paths, to } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { SessionScope } from '../../core/contracts/workspace'
import type { PlanRecord } from '../../core/model/schema'
import { nextOccurrence, planScope, relaunchFailed, sessionHistory } from '../../core/model/sessions'
import { formatDateTime, formatDuration } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import type { PlanNotice } from '../SessionSetup/PlanEditor.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import { downloadPlans } from './calendar.ts'
import { formatWhen, KIND_LABEL, planSchedule, scopeName, sessionLabel } from './describe.ts'
import { PracticeChip } from './PracticeChip.tsx'
import { PracticeSheet } from './PracticeSheet.tsx'
import styles from './Sessions.module.css'

/** Past sessions shown before "Show all sessions". */
const RECENT = 20

const noticeFrom = (state: unknown): PlanNotice =>
  typeof state === 'object' && state !== null ? (state as PlanNotice) : {}

/** Practice: a new session, a quiz, the statistics; then the planned sessions (create, edit, add to the calendar) and the history with each session's results. */
export default function Sessions() {
  const t = useT()
  const locale = useLocale()
  const ws = useWorkspace()
  const [, navigate] = useLocation()
  // « Quiz me » is the AI's: offered only with a model ready.
  const aiReady = useAiModel().status === 'ready'
  const [showAll, setShowAll] = useState(false)
  const [practicing, setPracticing] = useState<SessionScope | null>(null)
  const courses = useWorkspaceData(['courses', 'cards'], (w) =>
    w.courses.list().map((c) => ({ id: c.id, title: c.title, cards: w.cards.list({ courseId: c.id }).length })),
  )
  const [notice, setNotice] = useState<PlanNotice>(() => noticeFrom(history.state))
  const [message, setMessage] = useState<string | null>(null)
  const plans = useWorkspaceData(['plans'], (w) => w.plans.list())
  // Sessions left before any answer say nothing about the student's work: only those with results are listed.
  const past = useWorkspaceData(['sessions', 'reviews'], (w) => sessionHistory(w).filter((s) => s.reviews > 0))
  // Names follow renamed courses, subsets and plans.
  useWorkspaceData(['courses', 'sections'], () => null)
  const now = Date.now()

  const clearNotice = () => {
    setNotice({})
    clearEntryState()
  }
  const describe = (p: PlanRecord) => {
    const kind = t(KIND_LABEL[p.kind])
    const scope = scopeName(ws, planScope(p))
    return scope === null ? kind : t('review.sessionLabel', { kind, scope })
  }
  const calendar = (list: readonly PlanRecord[], name: string) => {
    try {
      downloadPlans(list, name, describe)
      setMessage(t('review.calendarDone'))
    } catch (e) {
      noteError('session.calendar', e)
      setMessage(t('review.calendarFailed'))
    }
  }
  const relaunch = (sessionId: string) => {
    const id = relaunchFailed(ws, sessionId)
    if (id !== null) navigate(to.sessionRun(id), { state: { session: id } })
  }
  const shown = showAll ? past : past.slice(0, RECENT)

  return (
    <Screen title={t('review.practice')} subtitle={t('review.practiceHint')}>
      <ListGroup>
        <ListRow
          href={paths.sessionNew}
          leading={<Play size={20} strokeWidth={1.75} />}
          title={t('review.newSession')}
          subtitle={t('review.newSessionBody')}
        />
        {aiReady && (
          <ListRow
            href={paths.quiz}
            leading={<ListChecks size={20} strokeWidth={1.75} />}
            title={t('ai.quiz')}
            subtitle={t('common.quizBody')}
          />
        )}
        <ListRow
          href={paths.stats}
          leading={<ChartColumn size={20} strokeWidth={1.75} />}
          title={t('common.statsTitle')}
          subtitle={t('review.statsBody')}
        />
      </ListGroup>
      {courses.some((c) => c.cards > 0) && (
        <ListGroup title={t('review.practiceCourses')}>
          {courses.length > 1 && (
            <ListRow
              leading={<Play size={20} strokeWidth={1.75} />}
              title={t('review.allCourses')}
              subtitle={t('course.cardCount', { count: courses.reduce((n, c) => n + c.cards, 0) })}
              onClick={() => setPracticing({})}
            />
          )}
          {courses
            .filter((c) => c.cards > 0)
            .map((c) => (
              <ListRow
                key={c.id}
                leading={<Play size={20} strokeWidth={1.75} />}
                title={c.title}
                subtitle={t('course.cardCount', { count: c.cards })}
                onClick={() => setPracticing({ courseId: c.id })}
              />
            ))}
        </ListGroup>
      )}
      <PracticeSheet open={practicing !== null} scope={practicing ?? {}} onClose={() => setPracticing(null)} />
      <ListGroup title={t('review.plannedSessions')} footer={plans.length === 0 ? t('review.plannedNone') : undefined}>
        {plans.map((p) => {
          const next = nextOccurrence(p, now)
          return (
            <ListRow
              key={p.id}
              href={to.sessionPlan(p.id)}
              title={
                <span className={styles.title}>
                  <span>{p.name}</span>
                  {p.practice && <PracticeChip />}
                </span>
              }
              subtitle={[
                planSchedule(locale, t, p.weekdays, p.time),
                describe(p),
                next === null ? null : t('review.planNext', { when: formatWhen(locale, t, next, now) }),
              ]
                .filter((x) => x !== null)
                .join(' · ')}
            />
          )
        })}
        <ListRow
          leading={<Plus size={20} strokeWidth={1.75} />}
          title={t('review.planSession')}
          onClick={() => navigate(to.sessionPlan('new'))}
        />
        {plans.length > 0 && (
          <ListRow
            leading={<CalendarPlus size={20} strokeWidth={1.75} />}
            title={plans.length === 1 ? t('review.addToCalendar') : t('review.addAllToCalendar')}
            onClick={() => calendar(plans, plans.length === 1 ? (plans[0]?.name ?? '') : t('review.sessions'))}
          />
        )}
      </ListGroup>

      <ListGroup title={t('review.pastSessions')} footer={past.length === 0 ? t('review.pastSessionsNone') : undefined}>
        {shown.map((s) => {
          const label = sessionLabel(ws, t, s.session)
          const failed = s.failed.length
          const facts = [
            formatDateTime(locale, s.session.startedAt),
            t('review.sessionCards', { count: s.cards }),
            failed > 0 ? t('review.sessionMissedShort', { count: failed }) : null,
            formatDuration(locale, s.durationMs),
          ].filter((x) => x !== null)
          return (
            <ListRow
              key={s.session.id}
              title={
                <span className={styles.title}>
                  <span>{label}</span>
                  {s.session.practice && <PracticeChip />}
                </span>
              }
              subtitle={
                <>
                  <span className={styles.facts} data-testid="session-facts">
                    {facts.join(' · ')}
                  </span>
                  {failed > 0 && (
                    <span className={styles.relaunch}>
                      <Button
                        variant="plain"
                        icon={<RotateCcw size={16} aria-hidden="true" />}
                        onClick={() => relaunch(s.session.id)}
                        aria-label={`${t('review.relaunchMissed')}: ${label}`}
                      >
                        {t('review.relaunchMissed')}
                      </Button>
                    </span>
                  )}
                </>
              }
            />
          )
        })}
        {past.length > RECENT && !showAll && (
          <ListRow title={t('review.showAllSessions')} onClick={() => setShowAll(true)} />
        )}
      </ListGroup>

      {notice.trashedPlan !== undefined && (
        <Toast
          message={t('review.planDeleted')}
          actions={[
            {
              label: t('review.planUndo'),
              onClick: () => {
                if (notice.trashedPlan !== undefined) ws.plans.restore(notice.trashedPlan)
                clearNotice()
              },
            },
            { label: t('review.dismiss'), onClick: clearNotice },
          ]}
        />
      )}
      {notice.planSaved === true && notice.trashedPlan === undefined && (
        <Toast message={t('review.planSaved')} actions={[{ label: t('review.dismiss'), onClick: clearNotice }]} />
      )}
      {message !== null && notice.trashedPlan === undefined && notice.planSaved !== true && (
        <Toast message={message} actions={[{ label: t('review.dismiss'), onClick: () => setMessage(null) }]} />
      )}
    </Screen>
  )
}
