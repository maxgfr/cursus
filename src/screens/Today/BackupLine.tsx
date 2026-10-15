import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { backupReminder, readLastBackup } from '../../app/lastBackup.ts'
import { paths } from '../../app/routes.ts'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './Today.module.css'

/**
 * One calm line about backups under the hero: « No backup yet » until something keeps a copy, and, with no
 * automatic backup, « Last backup N days ago » once the last saved file is more than a week old.
 */
export function BackupLine({ hasDestination, backedUp }: { hasDestination: boolean; backedUp: boolean }) {
  const t = useT()
  const rt = useRuntime()
  const [last, setLast] = useState<{ at: number | undefined } | null>(null)

  useEffect(() => {
    let live = true
    readLastBackup(rt.store)
      .then((at) => {
        if (live) setLast({ at })
      })
      .catch((e: unknown) => noteError('today.lastBackup', e))
    return () => {
      live = false
    }
  }, [rt])

  if (last === null) return null
  const r = backupReminder({ now: rt.clock.now(), last: last.at, hasDestination, backedUp })
  if (r.kind === 'none') return null
  return (
    <p className={styles.backup} data-testid="backup-line">
      {r.kind === 'stale' ? t('sync.lastBackupDays', { count: r.days }) : t('today.backupLine')} ·{' '}
      {r.kind === 'stale' ? (
        <Link href={paths.settingsData} className={styles.backupLink}>
          {t('sync.lastBackupAction')}
        </Link>
      ) : (
        <Link href={paths.settingsSync} className={styles.backupLink}>
          {t('today.backupAction')}
        </Link>
      )}
    </p>
  )
}
