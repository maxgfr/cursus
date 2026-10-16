import { paths } from '../../../app/routes.ts'
import { useT } from '../../../i18n/react.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import { saveBackupFile } from '../Data/backupFile.ts'
import { EraseSection } from '../Data/EraseSection.tsx'
import { GuardSection } from '../Data/GuardSection.tsx'
import { useAction, useDestinations } from '../Sync/hooks.tsx'
import styles from '../Sync/settings.module.css'

/** « Password & erasing »: the lock on destructive actions, and erasing everything this device holds. */
export default function SecuritySettings() {
  const t = useT()
  const { rt, engine } = useDestinations()
  const { busy, error, run } = useAction()
  // Erasing offers a backup file first: the same one Import & export saves.
  const backup = () =>
    run('backup', async () => {
      if (engine) await saveBackupFile(rt, engine, false)
    })
  return (
    <Screen title={t('common.setSecurity')} back={paths.settings}>
      <div className={styles.stack}>
        <p className={styles.prose}>{t('common.securityBody')}</p>
        {error && (
          <p className={styles.bad} role="alert">
            {error}
          </p>
        )}
        <GuardSection />
        <EraseSection onBackup={() => void backup()} backingUp={busy === 'backup'} />
      </div>
    </Screen>
  )
}
