import { useEffect, useState } from 'react'
import { useT } from '../../i18n/react.tsx'
import { Toast } from '../../ui/components/Toast.tsx'

/** Fired by the PWA layer (S-026) when a new service worker waits; `detail.apply()` updates. */
export const UPDATE_EVENT = 'cursus:update-ready'

export interface UpdateReadyDetail {
  apply: () => void
}

function isUpdateEvent(e: Event): e is CustomEvent<UpdateReadyDetail> {
  return e instanceof CustomEvent && typeof (e.detail as Partial<UpdateReadyDetail> | null)?.apply === 'function'
}

export default function UpdateToast() {
  const t = useT()
  const [pending, setPending] = useState<UpdateReadyDetail | null>(null)
  useEffect(() => {
    const on = (e: Event) => {
      if (isUpdateEvent(e)) setPending(e.detail)
    }
    window.addEventListener(UPDATE_EVENT, on)
    return () => window.removeEventListener(UPDATE_EVENT, on)
  }, [])
  if (!pending) return null
  return (
    <Toast
      message={t('common.updateReady')}
      actions={[
        { label: t('common.dismiss'), onClick: () => setPending(null) },
        { label: t('common.updateNow'), onClick: () => pending.apply() },
      ]}
    />
  )
}
