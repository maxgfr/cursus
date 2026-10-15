import { useEffect, useState } from 'react'
import { useT } from '../i18n/react.tsx'
import { consumeLaunchedFiles } from '../pwa/launch.ts'
import { Toast } from '../ui/components/Toast.tsx'
import { absorb, DestinationError } from './destinations.ts'
import { useSync } from './syncContext.tsx'
import { useRuntime } from './workspaceContext.tsx'

const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * App-wide outcomes of things that happen outside any screen: a `.cursus` file opened with the app
 * (merged as a pure union, like Settings › Data › Import), and a provider's consent page sending the
 * user back. Loaded after the first paint.
 */
export default function Notices() {
  const t = useT()
  const rt = useRuntime()
  const { engine, oauth, dismissOAuth } = useSync()
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    // After an update, a downloaded model's new engine script is stored before going offline needs it.
    const keep = () => {
      import('../screens/settings/Ai/onDeviceStore.ts')
        .then((m) => m.keepEngineFresh())
        .catch((e: unknown) => console.error('on-device engine not kept for offline use', e))
    }
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(keep, { timeout: 10_000 })
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(keep, 2_000)
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    if (!engine) return
    consumeLaunchedFiles(
      (files) => {
        void (async () => {
          const { zipStore } = await import('../core/sync/providers/zip')
          let added = 0
          for (const file of files) {
            const bytes = new Uint8Array(await file.arrayBuffer())
            const r = await absorb(rt, engine, zipStore({ bytes, label: `import-${rt.rng.id()}` }))
            if (r.error === 'workspace') return setMessage(t('sync.launchDeclined'))
            if (r.error) return setMessage(t('sync.launchFailed', { error: r.error }))
            added += r.added
          }
          setMessage(t('sync.launchImported', { count: added }))
        })().catch((e: unknown) => setMessage(t('sync.launchFailed', { error: errorOf(e) })))
      },
      (e) => setMessage(t('sync.launchFailed', { error: errorOf(e) })),
    )
  }, [engine, rt, t])

  const oauthText =
    oauth === null
      ? null
      : 'label' in oauth
        ? t('sync.connected', { name: oauth.label })
        : t('sync.oauthFailed', {
            error: oauth.error instanceof DestinationError ? t(`sync.${oauth.error.code}`) : errorOf(oauth.error),
          })
  const text = message ?? oauthText
  if (text === null) return null
  return (
    <Toast
      message={text}
      actions={[
        {
          label: t('common.dismiss'),
          onClick: () => (message !== null ? setMessage(null) : dismissOAuth()),
        },
      ]}
    />
  )
}
