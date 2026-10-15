import { useEffect, useState, useSyncExternalStore } from 'react'
import { startResiliently } from '../../app/chunkGuard.ts'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { type PwaUpdate, requestPersistence, startPwa, subscribeUpdate, toastUpdate } from '../../pwa/index.ts'
import { Toast } from '../../ui/components/Toast.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'

/** Starts the PWA layer and offers a waiting update (sealing first), unless a screen offers it in place. */
export default function UpdateToast() {
  const t = useT()
  const rt = useRuntime()
  const pending = useSyncExternalStore(subscribeUpdate, toastUpdate)
  const [dismissed, setDismissed] = useState<PwaUpdate | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    // A failed start only loses the update prompt: recorded for the diagnostic report, retried once.
    void startResiliently(() => startPwa({ seal: () => rt.seal(), report: noteError }), noteError)
    requestPersistence().catch((e: unknown) => noteError('storage.persist', e))
  }, [rt])

  if (pending && pending !== dismissed) {
    return (
      <Toast
        message={applying ? t('common.updating') : t('common.updateReady')}
        actions={
          applying
            ? []
            : [
                { label: t('common.dismiss'), onClick: () => setDismissed(pending) },
                {
                  label: t('common.updateNow'),
                  onClick: () => {
                    setApplying(true)
                    pending.apply().catch((e: unknown) => {
                      setApplying(false)
                      console.error('update failed', e)
                    })
                  },
                },
              ]
        }
      />
    )
  }
  return null
}
