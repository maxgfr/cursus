import { CalendarPlus, ChartColumn, FileUp, Share } from 'lucide-react'
import { type ChangeEvent, useRef, useState } from 'react'
import { Link } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id } from '../../core/contracts/workspace'
import { importCards } from '../../core/export/csvImport'
import { dayStart } from '../../core/srs/fsrs'
import { formatDate, formatDuration, formatPercent } from '../../i18n/format.ts'
import { intlTag } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { useFileLoader } from '../Photos/files.ts'
import { computeStats } from './compute.ts'
import { downloadCalendar, shareCourse } from './files.ts'
import styles from './Stats.module.css'

/** Calm statistics: what happened and what's coming. No streaks, no scores to chase. */
export default function Stats() {
  const t = useT()
  const locale = useLocale()
  const ws = useWorkspace()
  const loadFile = useFileLoader()
  const stats = useWorkspaceData(['courses', 'cards', 'reviews', 'prefs'], (w) => computeStats(w, Date.now()))
  const courses = useWorkspaceData(['courses'], (w) => w.courses.list())
  const [message, setMessage] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const importTarget = useRef<Id | null>(null)

  const weekday = new Intl.DateTimeFormat(intlTag(locale), { weekday: 'long' })
  const peak = Math.max(1, ...stats.days.map((d) => d.reviews))
  const total = stats.phases.new + stats.phases.learning + stats.phases.review + stats.phases.relearning

  const flash = (text: string) => {
    setMessage(text)
    setTimeout(() => setMessage((m) => (m === text ? null : m)), 4_000)
  }

  const onShare = (id: Id) => {
    shareCourse(ws, id, loadFile).then(
      (r) => {
        if (r !== 'cancelled') flash(t('common.shareDone'))
      },
      (e: unknown) => {
        console.error('share failed', e)
        flash(t('errors.generic'))
      },
    )
  }

  const onPickCsv = (id: Id) => {
    importTarget.current = id
    fileInput.current?.click()
  }

  const onCsv = (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget
    const file = input.files?.[0]
    const courseId = importTarget.current
    input.value = ''
    if (!file || courseId === null) return
    file.text().then(
      (text) => {
        const { created, skipped } = importCards(ws, courseId, text)
        const parts = [t('common.importCsvDone', { count: created })]
        if (skipped > 0) parts.push(t('common.importCsvSkipped', { count: skipped }))
        flash(parts.join(' · '))
      },
      (err: unknown) => {
        console.error('csv import failed', err)
        flash(t('errors.unsupportedFile'))
      },
    )
  }

  if (total === 0 && courses.length === 0) {
    return (
      <Screen title={t('common.statsTitle')} back={paths.settings}>
        <EmptyState
          icon={ChartColumn}
          title={t('common.statsEmptyTitle')}
          body={t('common.statsEmpty')}
          action={
            <Link href={paths.today} className={buttonClass({ variant: 'primary' })}>
              {t('common.statsEmptyAction')}
            </Link>
          }
        />
      </Screen>
    )
  }

  return (
    <Screen title={t('common.statsTitle')} back={paths.settings}>
      <div className={styles.sections}>
        <section aria-label={t('common.statsActivity')} className={styles.summary}>
          <div className={styles.tile}>
            <span className={styles.tileLabel}>{t('common.statsActivity')}</span>
            <span className={styles.tileValue}>{t('common.statsReviews', { count: stats.reviews })}</span>
            <span className={styles.tileHint}>
              {stats.practice > 0
                ? `${formatDuration(locale, stats.ms)} · ${t('review.statsCrammingShare', { count: stats.practice })}`
                : formatDuration(locale, stats.ms)}
            </span>
          </div>
          <div className={styles.tile}>
            <span className={styles.tileLabel}>{t('common.statsRetention')}</span>
            <span className={styles.tileValue} data-testid="retention">
              {stats.retention.rate === null ? '—' : formatPercent(locale, stats.retention.rate)}
            </span>
            <span className={styles.tileHint}>
              {stats.retention.rate === null ? t('common.statsRetentionNone') : t('common.statsRetentionHint')}
            </span>
          </div>
          <div className={styles.tile}>
            <span className={styles.tileLabel}>{t('common.statsCards')}</span>
            <span className={styles.tileValue}>{total}</span>
            <span className={styles.tileHint}>
              {t('common.statsPhaseNew')} {stats.phases.new} · {t('common.statsPhaseLearning')}{' '}
              {stats.phases.learning + stats.phases.relearning} · {t('common.statsPhaseReview')} {stats.phases.review}
            </span>
          </div>
          {stats.practice > 0 && (
            // Cramming apart: the student did it, but it never moved a review date nor the retention above.
            <div className={styles.tile} data-testid="cramming-tile">
              <span className={styles.tileLabel}>{t('review.statsCramming')}</span>
              <span className={styles.tileValue}>{t('common.statsReviews', { count: stats.practice })}</span>
              <span className={styles.tileHint}>
                {stats.practiceRetention.rate === null
                  ? t('review.statsCrammingNone')
                  : t('review.statsCrammingRate', { rate: formatPercent(locale, stats.practiceRetention.rate) })}
              </span>
            </div>
          )}
        </section>

        <div className={styles.tile}>
          <div
            className={styles.chart}
            role="img"
            aria-label={`${t('common.statsActivityChart')}: ${t('common.statsReviews', { count: stats.reviews })}`}
          >
            {stats.days.map((d) => (
              <span
                key={d.day}
                data-bar=""
                className={d.reviews === 0 ? `${styles.bar} ${styles.barEmpty}` : styles.bar}
                style={{ height: `${Math.round((d.reviews / peak) * 100)}%` }}
              />
            ))}
          </div>
        </div>

        <ListGroup title={t('common.statsForecast')}>
          {stats.forecast.map((f, i) => (
            <ListRow
              key={f.day}
              title={i === 0 ? t('common.cmdToday') : weekday.format(dayStart(f.day, stats.tz) + 12 * 3_600_000)}
              trailing={<span className={styles.count}>{t('common.statsForecastDay', { count: f.due })}</span>}
            />
          ))}
        </ListGroup>

        <ListGroup
          title={t('common.statsExams')}
          footer={stats.exams.length === 0 ? t('common.statsExamNone') : undefined}
        >
          {stats.exams.map((e) => (
            <ListRow
              key={e.courseId}
              href={to.course(e.courseId)}
              title={e.title}
              subtitle={formatDate(locale, new Date(`${e.examDate}T12:00:00`), 'long')}
              trailing={
                <span className={styles.count}>
                  {e.daysLeft === 0
                    ? t('common.statsExamToday')
                    : t('common.statsExamPlan', { days: e.daysLeft, count: e.goal.total })}
                </span>
              }
            />
          ))}
        </ListGroup>

        <ListGroup title={t('common.statsCourseTools')}>
          {courses.map((c) => (
            <ListRow
              key={c.id}
              title={c.title}
              trailing={
                <span className={styles.tools}>
                  <Button
                    icon={<Share size={16} aria-hidden="true" />}
                    onClick={() => onShare(c.id)}
                    aria-label={`${t('common.shareCourse')}: ${c.title}`}
                  >
                    {t('common.shareCourse')}
                  </Button>
                  <Button
                    icon={<FileUp size={16} aria-hidden="true" />}
                    onClick={() => onPickCsv(c.id)}
                    aria-label={`${t('common.importCsv')}: ${c.title}`}
                  >
                    {t('common.importCsv')}
                  </Button>
                </span>
              }
            />
          ))}
          <ListRow
            title={t('common.cmdCalendar')}
            leading={<CalendarPlus size={20} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => {
              downloadCalendar(ws, { daily: t('common.icsDaily'), examPrefix: t('common.icsExamPrefix') })
              flash(t('common.icsDone'))
            }}
          />
        </ListGroup>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
          hidden
          aria-hidden="true"
          tabIndex={-1}
          data-testid="csv-input"
          onChange={onCsv}
        />
      </div>
      {message !== null && <Toast message={message} />}
    </Screen>
  )
}
