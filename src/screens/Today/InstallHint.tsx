import { useEffect, useState } from 'react'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { INSTALL_HINT_KEY, needsIosInstallHint } from '../../pwa/index.ts'
import { Button } from '../../ui/components/Button.tsx'
import { stillDismissed } from './installSnooze.ts'
import styles from './Today.module.css'

/**
 * iOS Safari, not installed: what is added in a Safari tab stays in that tab, and the installed app
 * starts empty. Shown in Today's flow (first while the library is empty, under the hero after), until
 * the app runs installed or a backup destination exists.
 */
export function InstallHint({ hasDestination }: { hasDestination: boolean }) {
  const t = useT()
  const rt = useRuntime()
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!needsIosInstallHint()) return
    let live = true
    rt.store
      .read(['kv'], (tx) => tx.get<unknown>('kv', INSTALL_HINT_KEY))
      .then((stored) => {
        if (live && !stillDismissed(stored, Date.now())) setShow(true)
      })
      .catch((e: unknown) => console.error('install hint state unreadable', e))
    return () => {
      live = false
    }
  }, [rt])

  if (!show || hasDestination) return null
  const dismiss = () => {
    setShow(false)
    rt.store
      .commit([{ put: 'kv', key: INSTALL_HINT_KEY, value: Date.now() }])
      .catch((e: unknown) => console.error('install hint dismissal not saved', e))
  }
  return (
    <aside className={styles.installHint} aria-label={t('today.installHintLabel')} data-testid="install-hint">
      <p className={styles.installText}>
        <strong>{t('today.installHintTitle')}</strong> {t('today.installHintBody')}
      </p>
      <Button variant="plain" className={styles.installDismiss} onClick={dismiss}>
        {t('today.installHintDismiss')}
      </Button>
    </aside>
  )
}
