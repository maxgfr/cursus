import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id } from '../../core/contracts/workspace'
import { useT } from '../../i18n/react.tsx'
import styles from './Course.module.css'

/** The questions proposed for this course, as one calm line with the way to review them; nothing when none. */
export function DraftsLine({ courseId }: { courseId: Id }) {
  const t = useT()
  const count = useWorkspaceData(
    ['drafts', 'sources', 'courses', 'sections'],
    (ws) => ws.drafts.list({ courseId }).length,
  )
  if (count === 0) return null
  return (
    <p className={styles.draftsLine} data-testid="course-drafts">
      {t('ai.sourceProposed', { count })} ·{' '}
      <Link href={paths.inbox} className={styles.draftsLink}>
        {t('ai.sourceReview')}
      </Link>
    </p>
  )
}
