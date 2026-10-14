import { to } from '../../app/routes.ts'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { CourseDot } from '../../ui/components/Badges.tsx'
import { ListRow } from '../../ui/components/List.tsx'
import type { CourseStudy } from '../../ui/data/useStudy.ts'
import { daysUntil } from './exam.ts'
import styles from './Today.module.css'

/** "J-12"-style countdown to a course's exam; nothing once the date has passed. */
export function ExamCountdown({ examDate }: { examDate: string | undefined }) {
  const t = useT()
  const days = daysUntil(examDate)
  if (days === null || days < 0) return null
  return (
    <span className={styles.exam}>
      <span aria-hidden="true">{days === 0 ? t('today.examToday') : t('today.examCountdown', { count: days })}</span>
      <span className="sr-only">{days === 0 ? t('today.examToday') : t('today.examIn', { count: days })}</span>
    </span>
  )
}

/**
 * One row per course: colour, card count, the exam countdown and, as in the sidebar, a trailing
 * due count (nothing when none is due).
 */
export function CourseRows({ courses }: { courses: readonly CourseStudy[] }) {
  const t = useT()
  const exams = useWorkspaceData(['courses'], (ws) => new Map(ws.courses.list().map((c) => [c.id, c.examDate])))
  return courses.map((c) => (
    <ListRow
      key={c.id}
      href={to.course(c.id)}
      leading={<CourseDot hue={c.hue} />}
      title={c.title}
      subtitle={t('course.cardCount', { count: c.total })}
      trailing={
        <>
          <ExamCountdown examDate={exams.get(c.id)} />
          {c.due > 0 && (
            <span className={styles.due} data-testid="course-due">
              <span aria-hidden="true">{c.due}</span>
              <span className="sr-only">{t('today.courseDue', { count: c.due })}</span>
            </span>
          )}
        </>
      }
    />
  ))
}
