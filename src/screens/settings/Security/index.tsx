import { useEffect, useState } from 'react'
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
import { EncryptionSection } from './Encryption.tsx'
import { RecoverySections } from './Recovery.tsx'

/**
 * « Security », in the order it is needed: whether the local data opened normally, the password that guards
 * destructive actions and the encryption it can lock, how to recover the library, and erasing everything this
 * device holds, last.
 */
export default function SecuritySettings() {
  const t = useT()
  const save = useSaveState()
  const { rt, engine, records, reload } = useDestinations()
  const { busy, error, run } = useAction()
  // The password and the encryption it locks tell each other when they change.
  const [guardTick, setGuardTick] = useState(0)
  const [sealTick, setSealTick] = useState(0)
  // Older links to the Recovery and Encryption pages land here (`?at=recovery`, `?at=encryption`).
  const at = new URLSearchParams(useSearch()).get('at')
  const listed = records !== null
  useEffect(() => {
    if ((at === 'recovery' || at === 'encryption') && listed) {
      document.getElementById(at)?.scrollIntoView({ block: 'start' })
    }
  }, [at, listed])
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
        <GuardSection tick={sealTick} onChange={() => setGuardTick((n) => n + 1)} />
        <EncryptionSection
          rt={rt}
          engine={engine}
          records={records}
          reload={reload}
          guardTick={guardTick}
          onSealed={() => setSealTick((n) => n + 1)}
        />
        <div id="recovery" className={styles.stack}>
          <RecoverySections />
        </div>
        <EraseSection onBackup={() => void backup()} backingUp={busy === 'backup'} />
      </div>
    </Screen>
  )
}
