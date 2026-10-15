import { useEffect, useState, useSyncExternalStore } from 'react'
import { useRuntime } from '../../../app/workspaceContext.tsx'
import { intlTag } from '../../../i18n/index.ts'
import { useLocale, useT } from '../../../i18n/react.tsx'
import { checkForUpdate, UpdateDownloadError } from '../../../pwa/check.ts'
import { flushPending, offerInPlace, pendingUpdate, pwaRegistration, subscribeUpdate } from '../../../pwa/index.ts'
import { Button } from '../../../ui/components/Button.tsx'
import { noteError } from '../Diagnostic/recent.ts'
import styles from '../Sync/settings.module.css'

/** What the update control shows. `available` comes from the shared waiting worker, the toast's too. */
export type UpdateView =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; at: number }
  | { kind: 'available' }
  | { kind: 'applying' }
  | { kind: 'offline' }
  | { kind: 'unsupported' }
  | { kind: 'failed'; reason: 'check' | 'download' | 'apply' }

type Local = Exclude<UpdateView, { kind: 'available' } | { kind: 'offline' } | { kind: 'unsupported' }>

/** The last check that found nothing, for this page's life: Settings and Sync show the same time. */
let lastCurrent: number | null = null

const subscribeOnline = (fn: () => void) => {
  window.addEventListener('online', fn)
  window.addEventListener('offline', fn)
  return () => {
    window.removeEventListener('online', fn)
    window.removeEventListener('offline', fn)
  }
}

/** Checks for a new version and applies it (pending edits sealed first, exactly as the toast does). */
export function useAppUpdate() {
  const rt = useRuntime()
  const pending = useSyncExternalStore(subscribeUpdate, pendingUpdate)
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine)
  const [local, setLocal] = useState<Local>(
    lastCurrent === null ? { kind: 'idle' } : { kind: 'current', at: lastCurrent },
  )
  const [supported, setSupported] = useState<boolean | null>(null)

  useEffect(() => {
    let live = true
    pwaRegistration().then(
      (reg) => {
        if (live) setSupported(reg !== null)
      },
      // The failed start is already in the diagnostic report (pwa.start); here it means no update machinery.
      () => {
        if (live) setSupported(false)
      },
    )
    return () => {
      live = false
    }
  }, [])

  const view: UpdateView =
    local.kind === 'applying'
      ? local
      : pending
        ? { kind: 'available' }
        : supported === false
          ? { kind: 'unsupported' }
          : !online
            ? { kind: 'offline' }
            : local

  const check = async () => {
    setLocal({ kind: 'checking' })
    try {
      const found = await checkForUpdate()
      if (found === 'none') {
        lastCurrent = Date.now()
        setLocal({ kind: 'current', at: lastCurrent })
      } else {
        if (found === 'unsupported') setSupported(false)
        setLocal({ kind: 'idle' })
      }
    } catch (e) {
      noteError('pwa.check', e)
      setLocal({ kind: 'failed', reason: e instanceof UpdateDownloadError ? 'download' : 'check' })
    }
  }

  const apply = async () => {
    const update = pendingUpdate()
    if (!update) return
    setLocal({ kind: 'applying' })
    try {
      await update.apply()
    } catch (e) {
      noteError('pwa.apply', e)
      setLocal({ kind: 'failed', reason: 'apply' })
    }
  }

  /** Without a service worker a reload is the update: drafts and pending edits are saved first. */
  const reload = async () => {
    setLocal({ kind: 'applying' })
    try {
      await flushPending()
      await rt.seal()
      location.reload()
    } catch (e) {
      noteError('pwa.reload', e)
      setLocal({ kind: 'failed', reason: 'apply' })
    }
  }

  return { view, online, check, apply, reload }
}

/** One status line (announced) and the one action that fits it: check, update now, or reload. */
export function UpdateControl({ waitingChanges = false }: { waitingChanges?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const { view, online, check, apply, reload } = useAppUpdate()
  // Offered right here: the toast would only repeat it (and cover this button on a phone).
  useEffect(offerInPlace, [])
  const time = (at: number) => new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(at)

  const status =
    view.kind === 'checking'
      ? t('settings.updateChecking')
      : view.kind === 'current'
        ? `${t('settings.updateCurrent', { time: time(view.at) })}${waitingChanges ? ` ${t('settings.updateNoneYet')}` : ''}`
        : view.kind === 'available'
          ? t('settings.updateAvailable')
          : view.kind === 'applying'
            ? t('common.updating')
            : view.kind === 'offline'
              ? t('settings.updateOffline')
              : view.kind === 'unsupported'
                ? t('settings.updateUnsupported')
                : view.kind === 'failed'
                  ? t(
                      view.reason === 'download'
                        ? 'settings.updateDownloadFailed'
                        : view.reason === 'apply'
                          ? 'settings.updateApplyFailed'
                          : 'settings.updateFailed',
                    )
                  : ''

  return (
    <div className={styles.section}>
      <p className={styles.note} role="status" data-testid="update-status">
        {status}
      </p>
      <div className={styles.actions}>
        {view.kind === 'available' || (view.kind === 'applying' && pendingUpdate()) ? (
          <Button variant="primary" loading={view.kind === 'applying'} onClick={() => void apply()}>
            {t('settings.updateNow')}
          </Button>
        ) : view.kind === 'unsupported' || view.kind === 'applying' ? (
          <Button loading={view.kind === 'applying'} disabled={!online} onClick={() => void reload()}>
            {t('common.reload')}
          </Button>
        ) : (
          <Button loading={view.kind === 'checking'} disabled={view.kind === 'offline'} onClick={() => void check()}>
            {t('settings.updateCheck')}
          </Button>
        )}
      </div>
    </div>
  )
}
