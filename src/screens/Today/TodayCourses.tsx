import { Play } from 'lucide-react'
import { useLocation } from 'wouter'
import { to } from '../../app/routes.ts'
import { dayStart, localOffset, studyDay } from '../../core/srs/fsrs'
import type { TodayReason } from '../../core/srs/today'
import { intlTag } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { CourseDot } from '../../ui/components/Badges.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import type { StudySummary } from '../../ui/data/useStudy.ts'
import styles from './Today.module.css'

/** Within the week an exam is named by its day: « Exam Thursday »; further off, by the days left. */
const WEEKDAY_WITHIN = 6
const HALF_DAY_MS = 12 * 3_600_000

/** What Today says under a course's name: why it comes where it does. */
function useReason(): (r: TodayReason) => string {
  const t = useT()
  const locale = useLocale()
  return (r) => {
    switch (r.kind) {
      case 'exam': {
        if (r.days === 0) return t('today.examToday')
        if (r.days === 1) return t('today.examTomorrow')
        if (r.days > WEEKDAY_WITHIN) return t('today.examIn', { count: r.days })
        // Midday of that study day (which starts at 04:00): its weekday, whatever the hour now.
        const now = Date.now()
        const tz = localOffset(now)
        const at = dayStart(studyDay(now, tz) + r.days, tz) + HALF_DAY_MS
        const weekday = new Intl.DateTimeFormat(intlTag(locale), { weekday: 'long' }).format(at)
        return t('today.examOn', { weekday })
      }
      case 'late':
        return t('today.reasonLate', { count: r.count })
      case 'fragile':
        return t('today.reasonFragile', { count: r.count })
      case 'due':
        return t('today.courseDue', { count: r.count })
      case 'new':
        return t('common.newShort', { count: r.count })
    }
  }
}

/**
 * The courses with work today, most urgent first, each with its reason and its share of today's queue: one tap
 * reviews that share. A quiet line says the other courses have nothing today.
 */
export function TodayCourses({ study }: { study: StudySummary }) {
  const t = useT()
  const reason = useReason()
  const [, navigate] = useLocation()
  if (study.today.length === 0) return null
  const byId = new Map(study.courses.map((c) => [c.id, c]))
  const others = study.courses.some((c) => c.total > 0 && !study.today.some((x) => x.courseId === c.id))
  return (
    <ListGroup title={t('today.byCourse')} footer={others ? t('today.nothingElse') : undefined}>
      {study.today.map((c) => {
        const course = byId.get(c.courseId)
        if (!course) return null
        return (
          <ListRow
            key={c.courseId}
            onClick={() => navigate(to.reviewToday(c.courseId))}
            leading={<CourseDot hue={course.hue} />}
            title={course.title}
            subtitle={<span data-testid="course-reason">{reason(c.reason)}</span>}
            trailing={
              <span className={styles.courseStart} data-testid="course-today">
                <span aria-hidden="true" className={styles.due}>
                  {c.total}
                </span>
                <Play size={16} aria-hidden="true" />
                <span className="sr-only">{t('today.reviewCourse', { count: c.total })}</span>
              </span>
            }
          />
        )
      })}
    </ListGroup>
  )
}
