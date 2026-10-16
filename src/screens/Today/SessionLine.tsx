import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { PlanRecord } from '../../core/model/schema'
import { livePlans, nextPlanned } from '../../core/model/sessions'
import { useLocale, useT } from '../../i18n/react.tsx'
import { formatWhen } from '../Sessions/describe.ts'
import styles from './Today.module.css'

/**
 * The next planned session, as one calm line under the hero; nothing when none is planned. `today`, one planned for
 * today and not started yet (its time may have passed), is the one said, with a way to start it.
 */
export function SessionLine({
  today,
  onStart,
}: {
  today: { plan: PlanRecord; at: number } | null
  onStart: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const now = Date.now()
  // A plan over a course in the trash waits there with it (and comes back with it).
  const next = useWorkspaceData(['plans', 'courses', 'sections'], (ws) => nextPlanned(livePlans(ws), Date.now()))
  const planned = today ?? next
  if (planned === null) return null
  return (
    <p className={styles.backup} data-testid="session-line">
      {t('review.todayNext', { name: planned.plan.name, when: formatWhen(locale, t, planned.at, now) })} ·{' '}
      {today !== null && (
        <>
          <button type="button" className={styles.backupLink} onClick={onStart}>
            {t('review.startNow')}
          </button>{' '}
          ·{' '}
        </>
      )}
      <Link href={paths.sessions} className={styles.backupLink}>
        {t('review.sessions')}
      </Link>
    </p>
  )
}
