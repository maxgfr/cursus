import { useEffect } from 'react'
import { useSearch } from 'wouter'
import { paths } from '../../../app/routes.ts'
import { useSaveState } from '../../../app/workspaceContext.tsx'
import { useT } from '../../../i18n/react.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import { saveBackupFile } from '../Data/backupFile.ts'
import { EraseSection } from '../Data/EraseSection.tsx'
import { GuardSection } from '../Data/GuardSection.tsx'
import { useAction, useDestinations } from '../Sync/hooks.tsx'
import styles from '../Sync/settings.module.css'
import { RecoverySections } from './Recovery.tsx'

/**
 * « Security », in the order it is needed: whether the local data opened normally, the password that guards
 * destructive actions, how to recover the library, and erasing everything this device holds, last.
 */
export default function SecuritySettings() {
  const t = useT()
  const save = useSaveState()
  const { rt, engine } = useDestinations()
  const { busy, error, run } = useAction()
  // An older link to the Recovery page lands here (`?at=recovery`): its section is brought into view.
  const at = new URLSearchParams(useSearch()).get('at')
  useEffect(() => {
    if (at === 'recovery') document.getElementById('recovery')?.scrollIntoView({ block: 'start' })
  }, [at])
  // Erasing offers a backup file first: the same one Import & export saves.
  const backup = () =>
    run('backup', async () => {
      if (engine) await saveBackupFile(rt, engine, false)
    })
  const healthy = !save.blocked && !save.versionChanged
  return (
    <Screen title={t('common.setSecurity')} back={paths.settings}>
      <div className={styles.stack}>
        <p className={styles.prose}>{t('common.securityBody')}</p>
        <p className={healthy ? styles.ok : styles.bad} role="status">
          {healthy
            ? t('common.recoveryBody')
            : save.blocked
              ? t('common.saveBlockedBody')
              : t('common.versionChangedBody')}
        </p>
        {error && (
          <p className={styles.bad} role="alert">
            {error}
          </p>
        )}
        <GuardSection />
        <div id="recovery" className={styles.stack}>
          <RecoverySections />
        </div>
        <EraseSection onBackup={() => void backup()} backingUp={busy === 'backup'} />
      </div>
    </Screen>
  )
}
