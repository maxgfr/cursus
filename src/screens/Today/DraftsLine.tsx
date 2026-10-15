import { useEffect } from 'react'
import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { resumeAutoQuestions } from '../../ui/data/autoQuestions.ts'
import styles from './Today.module.css'

/** Left to the first paint: questions still to propose (the app was closed meanwhile) run again after it. */
const RESUME_AFTER_MS = 1500

/**
 * Questions proposed on the documents added, as one calm line under the hero (« 12 questions proposed from
 * Physiology · Review »); nothing when there are none. Counts come from the synced drafts, not the AI code.
 */
export function DraftsLine({ hidden = false }: { hidden?: boolean }) {
  const t = useT()
  const rt = useRuntime()
  const line = useWorkspaceData(['drafts', 'sources', 'courses', 'sections'], (ws) => {
    const { total, sources } = ws.drafts.summary()
    if (total === 0) return null
    const courses = new Set(sources.map((s) => s.courseId))
    const first = sources[0]
    return { total, courses: courses.size, course: first ? (ws.courses.get(first.courseId)?.title ?? '') : '' }
  })
  useEffect(() => {
    const timer = setTimeout(() => void resumeAutoQuestions(rt), RESUME_AFTER_MS)
    return () => clearTimeout(timer)
  }, [rt])
  // The hero says it already when nothing is due: the line stays away, the pending proposals still resume.
  if (line === null || hidden) return null
  return (
    <p className={styles.backup} data-testid="drafts-line">
      {line.courses === 1
        ? t('today.draftsLine', { count: line.total, course: line.course })
        : t('today.draftsLineCourses', { count: line.total, courses: line.courses })}{' '}
      ·{' '}
      <Link href={paths.inbox} className={styles.backupLink}>
        {t('today.draftsReview')}
      </Link>
    </p>
  )
}
