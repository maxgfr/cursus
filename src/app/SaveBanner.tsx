import { useEffect, useState } from 'react'
import { useT } from '../i18n/react.tsx'
import { Banner } from '../ui/components/Banner.tsx'
import { Button } from '../ui/components/Button.tsx'
import { useRuntime, useSaveState } from './workspaceContext.tsx'

/** Shell-level "not saved on this device" and "updated in another tab" alerts, on every route. */
export function SaveBanner() {
  const t = useT()
  const rt = useRuntime()
  const save = useSaveState()
  const [retrying, setRetrying] = useState(false)

  // Closing the tab now would lose the edits the local log has not acknowledged.
  useEffect(() => {
    if (save.unsaved === 0) return
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [save.unsaved])

  if (save.versionChanged)
    return (
      <Banner
        title={t('common.versionChangedTitle')}
        body={t('common.versionChangedBody')}
        action={
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t('common.reload')}
          </Button>
        }
      />
    )
  if (save.blocked)
    return (
      <Banner
        title={t('common.syncUnsaved')}
        body={t('common.saveBlockedBody')}
        action={
          <Button
            variant="primary"
            disabled={retrying}
            onClick={() => {
              setRetrying(true)
              rt.capture.retry().finally(() => setRetrying(false))
            }}
          >
            {t('common.retry')}
          </Button>
        }
      />
    )
  return null
}
