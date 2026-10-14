import { useEffect, useState } from 'react'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { type PwaUpdate, requestPersistence, startPwa } from '../../pwa/index.ts'
import { Toast } from '../../ui/components/Toast.tsx'

/** Starts the PWA layer and offers a waiting update (sealing first). */
export default function UpdateToast() {
  const t = useT()
  const rt = useRuntime()
  const [pending, setPending] = useState<PwaUpdate | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    void startPwa({ onUpdate: setPending, seal: () => rt.seal() })
    void requestPersistence()
  }, [rt])

  if (pending) {
    return (
      <Toast
        message={applying ? t('common.updating') : t('common.updateReady')}
        actions={
          applying
            ? []
            : [
                { label: t('common.dismiss'), onClick: () => setPending(null) },
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
