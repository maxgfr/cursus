import { Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Sheet } from '../../../ui/components/Sheet.tsx'
import { useGuard } from '../../../ui/PasswordGate.tsx'
import { noteError } from '../Diagnostic/recent.ts'
import styles from '../Sync/settings.module.css'
import { eraseThisDevice } from './erase.ts'
import { useStopWriting } from './stopWriting.ts'

const GOES = [
  'settings.eraseCourses',
  'settings.eraseHistory',
  'settings.eraseSettings',
  'settings.eraseAi',
  'settings.eraseChats',
] as const

type Phase = 'idle' | 'erasing' | 'blocked' | 'failed'

/** « Erase everything on this device »: a danger zone, confirmed in two steps; remote copies are never touched. */
export function EraseSection({ onBackup, backingUp }: { onBackup: () => void; backingUp: boolean }) {
  const t = useT()
  const stop = useStopWriting()
  const [open, setOpen] = useState(false)
  const [understood, setUnderstood] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const checkId = useId()
  const { guard, sheet: guardSheet } = useGuard()

  const close = () => {
    if (phase === 'erasing' || phase === 'blocked') return
    setOpen(false)
    setUnderstood(false)
    setPhase('idle')
  }

  const erase = async () => {
    setPhase('erasing')
    try {
      await eraseThisDevice({ stop, onBlocked: () => setPhase('blocked') })
    } catch (e) {
      noteError('data.erase', e)
      setPhase('failed')
      return
    }
    // A fresh start: the app opens on the welcome, with nothing from before.
    location.replace(import.meta.env.BASE_URL)
  }

  return (
    <section className={styles.card} aria-labelledby="data-erase">
      <h2 id="data-erase" className={styles.sectionTitle}>
        {t('settings.eraseTitle')}
      </h2>
      <p className={styles.prose}>{t('settings.eraseBody')}</p>
      <div className={styles.actions}>
        <Button variant="danger" icon={<Trash2 size={18} aria-hidden="true" />} onClick={() => setOpen(true)}>
          {t('settings.resetData')}
        </Button>
      </div>
      <Sheet open={open} title={t('settings.resetData')} onClose={close}>
        <div className={styles.stack}>
          <p className={styles.prose}>{t('settings.resetConfirm')}</p>
          <ul className={styles.prose}>
            {GOES.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
          <p className={styles.prose}>{t('settings.eraseRemote')}</p>
          <div className={styles.actions}>
            <Button onClick={onBackup} loading={backingUp}>
              {t('settings.eraseBackupFirst')}
            </Button>
          </div>
          <label className={styles.check} htmlFor={checkId}>
            <input
              id={checkId}
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            <span>{t('settings.eraseUnderstood')}</span>
          </label>
          {phase === 'blocked' && (
            <p className={styles.warn} role="alert">
              {t('settings.eraseBlocked')}
            </p>
          )}
          {phase === 'failed' && (
            <p className={styles.bad} role="alert">
              {t('settings.eraseFailed')}
            </p>
          )}
          <div className={styles.actions}>
            <Button
              variant="danger"
              icon={<Trash2 size={18} aria-hidden="true" />}
              disabled={!understood || phase === 'failed'}
              loading={phase === 'erasing' || phase === 'blocked'}
              onClick={() => guard(erase)}
            >
              {t('settings.eraseConfirm')}
            </Button>
          </div>
        </div>
      </Sheet>
      {guardSheet}
    </section>
  )
}
