import { useCallback, useEffect, useRef, useState } from 'react'
import { useSync } from '../../../app/syncContext.tsx'
import { useRuntime } from '../../../app/workspaceContext.tsx'
import type { Translate } from '../../../i18n/index.ts'
import { useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Sheet } from '../../../ui/components/Sheet.tsx'
import { DestinationError, type DestRecord, listRecords } from './registry.ts'
import styles from './settings.module.css'

/** Remembered destinations (the app re-attaches them to the engine at boot). */
export function useDestinations() {
  const rt = useRuntime()
  const sync = useSync()
  const [records, setRecords] = useState<DestRecord[] | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    let live = true
    void version
    listRecords(rt).then((r) => {
      if (live) setRecords(r)
    })
    return () => {
      live = false
    }
  }, [rt, version])

  return { rt, ...sync, records, reload }
}

type Question = { dest: string; local: string | null; remote: string[] }

/**
 * Asks before a destination holding another library is merged into this non-empty one (a CRDT
 * merge cannot be undone). Installed while the screen is open; the answer is "no" otherwise.
 */
export function useWorkspaceConfirm() {
  const t = useT()
  const { setWorkspaceConfirmer } = useSync()
  const [q, setQ] = useState<Question | null>(null)
  const answer = useRef<((yes: boolean) => void) | null>(null)

  useEffect(() => {
    setWorkspaceConfirmer(
      (question) =>
        new Promise<boolean>((resolve) => {
          answer.current = resolve
          setQ(question)
        }),
    )
    return () => {
      setWorkspaceConfirmer(null)
      answer.current?.(false)
    }
  }, [setWorkspaceConfirmer])

  const reply = (yes: boolean) => {
    answer.current?.(yes)
    answer.current = null
    setQ(null)
  }

  return (
    <Sheet open={q !== null} title={t('sync.mergeTitle')} onClose={() => reply(false)}>
      <p className={styles.prose}>{t('sync.mergeBody', { dest: q?.dest ?? '' })}</p>
      <div className={styles.actions}>
        <Button variant="primary" onClick={() => reply(true)}>
          {t('sync.mergeYes')}
        </Button>
        <Button onClick={() => reply(false)}>{t('common.cancel')}</Button>
      </div>
    </Sheet>
  )
}

/** What a failure says to the user: registry errors are translated, others carry their own message. */
export function errorText(t: Translate, e: unknown): string {
  if (e instanceof DestinationError) return t(`sync.${e.code}`)
  return e instanceof Error ? e.message : String(e)
}

/** Runs an async action with a busy flag and a readable error (registry errors in the current language). */
export function useAction() {
  const t = useT()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(
    async (name: string, fn: () => Promise<void>) => {
      setBusy(name)
      setError(null)
      try {
        await fn()
      } catch (e) {
        setError(errorText(t, e))
      } finally {
        setBusy(null)
      }
    },
    [t],
  )
  return { busy, error, setError, run }
}
