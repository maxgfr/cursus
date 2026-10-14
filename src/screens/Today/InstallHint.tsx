import { useEffect, useState } from 'react'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { INSTALL_HINT_KEY, needsIosInstallHint } from '../../pwa/index.ts'
import { Button } from '../../ui/components/Button.tsx'
import styles from './Today.module.css'

/**
 * iOS Safari, not installed: a quiet note in Today's flow. It sits with the content rather than
 * floating over the bottom of every screen, where it would cover the controls students need.
 */
export function InstallHint() {
  const t = useT()
  const rt = useRuntime()
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!needsIosInstallHint()) return
    let live = true
    rt.store
      .read(['kv'], (tx) => tx.get<boolean>('kv', INSTALL_HINT_KEY))
      .then((dismissed) => {
        if (live && dismissed !== true) setShow(true)
      })
      .catch((e: unknown) => console.error('install hint state unreadable', e))
    return () => {
      live = false
    }
  }, [rt])

  if (!show) return null
  const dismiss = () => {
    setShow(false)
    rt.store
      .commit([{ put: 'kv', key: INSTALL_HINT_KEY, value: true }])
      .catch((e: unknown) => console.error('install hint dismissal not saved', e))
  }
  return (
    <aside className={styles.installHint} aria-label={t('today.installTitle')}>
      <p className={styles.meta}>{t('common.installHint')}</p>
      <Button onClick={dismiss}>{t('common.installDismiss')}</Button>
    </aside>
  )
}
