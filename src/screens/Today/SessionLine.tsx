import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import { livePlans, nextPlanned } from '../../core/model/sessions'
import { useLocale, useT } from '../../i18n/react.tsx'
import { formatWhen } from '../Sessions/describe.ts'
import styles from './Today.module.css'

/** The next planned session, as one calm line under the hero; nothing when none is planned. */
export function SessionLine() {
  const t = useT()
  const locale = useLocale()
  const now = Date.now()
  // A plan over a course in the trash waits there with it (and comes back with it).
  const planned = useWorkspaceData(['plans', 'courses', 'sections'], (ws) => nextPlanned(livePlans(ws), Date.now()))
  if (planned === null) return null
  return (
    <p className={styles.backup} data-testid="session-line">
      {t('review.todayNext', { name: planned.plan.name, when: formatWhen(locale, t, planned.at, now) })} ·{' '}
      <Link href={paths.sessions} className={styles.backupLink}>
        {t('review.sessions')}
      </Link>
    </p>
  )
}
