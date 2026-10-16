import { useCallback, useEffect, useRef, useState } from 'react'
import { noteLoadFailure } from '../../../app/chunkGuard.ts'
import { paths } from '../../../app/routes.ts'
import { useSaveState } from '../../../app/workspaceContext.tsx'
import { useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import { localDatabases } from '../Recovery/rawExport.ts'
import { useAction, useDestinations } from '../Sync/hooks.tsx'
import { download, fileStamp } from '../Sync/registry.ts'
import styles from '../Sync/settings.module.css'
import { noteError, recentErrors } from './recent.ts'
import { VersionSection } from './Version.tsx'

const MAX_EVENTS = 200

/** A support report with no secret in it: versions, storage, and what sync did while this screen was open. */
export default function DiagnosticSettings() {
  const t = useT()
  const save = useSaveState()
  const { rt, engine, scheduler, status, records, online, error: engineError } = useDestinations()
  const { busy, error, run } = useAction()
  const events = useRef<string[]>([])
  const [report, setReport] = useState('')
  const [copied, setCopied] = useState(false)

  // The event log: every status change while the screen is open, oldest first.
  useEffect(() => {
    if (!status) return
    const line = [
      new Date(rt.clock.now()).toISOString(),
      `safe=${status.safe}`,
      `unsealed=${status.unsealed}`,
      `needsUpgrade=${status.needsUpgrade}`,
      ...status.dests.map((d) => `${d.id}:${d.state}${d.error ? `(${d.error.kind}: ${d.error.message})` : ''}`),
    ].join(' ')
    if (events.current.at(-1)?.slice(25) !== line.slice(25))
      events.current = [...events.current, line].slice(-MAX_EVENTS)
  }, [status, rt])

  const build = useCallback(async () => {
    const { persisted, estimate } = await import('../../../core/storage/persist')
    const data = {
      generatedAt: new Date(rt.clock.now()).toISOString(),
      userAgent: navigator.userAgent,
      language: navigator.language,
      online,
      standalone: matchMedia('(display-mode: standalone)').matches,
      storage: { persisted: await persisted(), estimate: await estimate() },
      databases: await localDatabases(),
      device: await rt.log.deviceId(),
      workspace: engine ? await engine.workspaceId() : null,
      localObjects: (await rt.log.keys()).size,
      // Synced review events this version cannot read: kept in the library, left out of the schedule.
      unreadableReviews: rt.ws.reviews.quarantined(),
      save,
      engineError: engineError === null ? null : String(engineError),
      destinations: (records ?? []).map((r) => ({
        id: r.id,
        kind: r.kind,
        paused: r.paused === true,
        sealed: r.sealed === true,
      })),
      status: status && {
        ...status,
        dests: status.dests.map((d) => ({ ...d, failures: scheduler?.failures(d.id) ?? 0 })),
      },
      events: events.current,
      errors: recentErrors(),
    }
    return JSON.stringify(data, null, 2)
  }, [rt, engine, scheduler, status, records, online, save, engineError])

  useEffect(() => {
    let live = true
    build().then(
      (r) => {
        if (live) setReport(r)
      },
      (e: unknown) => {
        if (!noteLoadFailure('diagnostic.build', e, noteError) && live) setReport(String(e))
      },
    )
    return () => {
      live = false
    }
  }, [build])

  return (
    <Screen title={t('common.setDiagnostic')} back={paths.settings}>
      <div className={styles.stack}>
        <VersionSection />
        <p className={styles.prose}>{t('common.diagnosticBody')}</p>
        <p className={styles.note}>{t('settings.diagNoSecrets')}</p>
        <div className={styles.actions}>
          <Button
            variant="primary"
            loading={busy === 'export'}
            onClick={() =>
              void run('export', async () => {
                download(await build(), `cursus-diagnostic-${fileStamp(rt.clock.now())}.json`, 'application/json')
              })
            }
          >
            {t('settings.diagExport')}
          </Button>
          <Button
            onClick={() =>
              void run('copy', async () => {
                await navigator.clipboard.writeText(await build())
                setCopied(true)
              })
            }
          >
            {copied ? t('settings.diagCopied') : t('settings.diagCopy')}
          </Button>
        </div>
        {error && (
          <p className={styles.bad} role="alert">
            {error}
          </p>
        )}
        <h2 className={styles.label}>{t('settings.diagReport')}</h2>
        {/* Wraps instead of scrolling: no scroll area a keyboard could not reach. */}
        <pre className={`${styles.code} ${styles.report}`} translate="no">
          {report || t('common.loading')}
        </pre>
      </div>
    </Screen>
  )
}
