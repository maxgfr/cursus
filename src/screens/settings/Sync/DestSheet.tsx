import { useState } from 'react'
import type { Runtime } from '../../../app/workspaceContext.tsx'
import type { SyncEngineImpl } from '../../../core/sync/engine'
import type { SyncScheduler } from '../../../core/sync/scheduler'
import type { EngineDestStatus } from '../../../core/sync/status'
import { formatDateTime } from '../../../i18n/format.ts'
import type { Translate } from '../../../i18n/index.ts'
import { useLocale, useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { Sheet } from '../../../ui/components/Sheet.tsx'
import { beginOAuth, cloudkitSignIn, commit, pickFolder } from './connect.ts'
import { useAction } from './hooks.tsx'
import { type DestRecord, deleteRecord, keyringFor, saveRecord, syncNow } from './registry.ts'
import { S3Form } from './S3Form.tsx'
import styles from './settings.module.css'

/** One line saying where a destination stands, from the verified status only. */
export function stateText(t: Translate, d: EngineDestStatus): string {
  if (d.state === 'paused') return t('sync.statePaused')
  if (d.reason === 'workspace') return t('sync.stateWorkspace')
  if (d.reason === 'corrupt' || d.corrupt > 0) return t('sync.stateCorrupt', { count: d.corrupt })
  if (d.state === 'needs-auth') return t('sync.stateAuth')
  if (d.state === 'needs-passphrase') return t('sync.statePassphrase')
  if (d.state === 'needs-permission') return t('sync.statePermission')
  if (d.state === 'error') return d.error?.kind === 'cors' ? t('sync.stateCors') : t('sync.stateError')
  if (d.state === 'backoff') return t('sync.stateBackoff')
  if (d.state === 'syncing') return t('sync.syncing')
  return d.unconfirmed > 0 ? t('sync.pending', { count: d.unconfirmed }) : t('sync.synced')
}

export interface DestSheetProps {
  rt: Runtime
  engine: SyncEngineImpl
  scheduler: SyncScheduler
  status: EngineDestStatus
  record: DestRecord | undefined
  onClose: () => void
  onChanged: () => void
}

export function DestSheet({ rt, engine, scheduler, status: d, record, onClose, onChanged }: DestSheetProps) {
  const t = useT()
  const locale = useLocale()
  const { busy, error, run } = useAction()
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [report, setReport] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string; lines?: string[] } | null>(null)
  const [editing, setEditing] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const paused = d.state === 'paused'
  const when = (ms: number | undefined) => (ms === undefined ? t('sync.never') : formatDateTime(locale, ms))

  const verify = () =>
    run('verify', async () => {
      setReport(null)
      setProgress({ done: 0, total: 0 })
      const r = await engine.verify(d.id, (done, total) => setProgress({ done, total }))
      setProgress(null)
      await engine.refresh()
      const tone = r.corrupt > 0 ? 'bad' : r.repaired > 0 ? 'warn' : 'ok'
      setReport({
        tone,
        text:
          r.corrupt > 0
            ? t('sync.verifyCorrupt', { count: r.corrupt })
            : r.repaired > 0
              ? t('sync.verifyRepaired', { count: r.repaired })
              : t('sync.verifyOk'),
      })
    })

  const drill = () =>
    run('drill', async () => {
      setReport(null)
      const r = await engine.restoreDrill(d.id)
      setReport(
        r.equal
          ? { tone: 'ok', text: t('sync.drillOk') }
          : { tone: 'bad', text: t('sync.drillDiff', { count: r.diff.length }), lines: r.diff.slice(0, 20) },
      )
    })

  const pause = () =>
    run('pause', async () => {
      engine.setPaused(d.id, !paused)
      if (record) await saveRecord(rt, { ...record, paused: !paused })
      if (paused) scheduler.trigger('manual')
      await engine.refresh()
      onChanged()
    })

  const reconnect = () =>
    run('reconnect', async () => {
      if (!record) return
      if (record.kind === 's3') return setEditing(true)
      if (record.kind === 'gdrive' || record.kind === 'dropbox') {
        const { id: _id, ...draft } = record
        location.assign(await beginOAuth(rt, draft))
        return
      }
      if (record.kind === 'cloudkit') {
        const url = await cloudkitSignIn(rt, record)
        if (url) location.assign(url)
        else await syncNow(rt, engine, scheduler)
        return
      }
      await pickFolder(rt, engine, record.kind, record.label)
      onChanged()
    })

  const unlock = () =>
    run('unlock', async () => {
      const n = await keyringFor(rt, d.id).unlock(passphrase)
      setPassphrase('')
      if (n === 0) throw new Error(t('sync.passphraseWrong'))
      await syncNow(rt, engine, scheduler)
    })

  const remove = () =>
    run('remove', async () => {
      engine.removeDest(d.id)
      await deleteRecord(rt, d.id)
      await engine.refresh()
      onChanged()
      onClose()
    })

  const needsReconnect = d.state === 'needs-auth' || d.state === 'needs-permission' || d.state === 'error'

  return (
    <Sheet open title={d.label} onClose={onClose}>
      <div className={styles.stack}>
        <dl className={styles.facts}>
          <dt>{t('sync.factState')}</dt>
          <dd>{stateText(t, d)}</dd>
          <dt>{t('sync.factLastOk')}</dt>
          <dd>{when(d.lastOkAt)}</dd>
          <dt>{t('sync.factVerified')}</dt>
          <dd>{when(d.lastVerifiedAt)}</dd>
          <dt>{t('sync.factWaiting')}</dt>
          <dd>{d.unconfirmed}</dd>
          {d.nextTryAt !== undefined && (
            <>
              <dt>{t('sync.factRetry')}</dt>
              <dd>{when(d.nextTryAt)}</dd>
            </>
          )}
          {d.error && (
            <>
              <dt>{t('sync.factError')}</dt>
              <dd>{d.error.message}</dd>
            </>
          )}
        </dl>

        {d.state === 'needs-passphrase' && (
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault()
              void unlock()
            }}
          >
            <Field
              label={t('sync.passphrase')}
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            <div className={styles.actions}>
              <Button type="submit" variant="primary" loading={busy === 'unlock'} disabled={!passphrase}>
                {t('sync.unlock')}
              </Button>
            </div>
          </form>
        )}

        {editing && record?.kind === 's3' ? (
          <S3Form
            initial={record}
            onSave={async (r) => {
              await commit(rt, engine, { ...r, id: record.id })
              setEditing(false)
              onChanged()
              scheduler.trigger('manual')
            }}
          />
        ) : (
          <div className={styles.actions}>
            {needsReconnect && (
              <Button variant="primary" onClick={reconnect} loading={busy === 'reconnect'}>
                {t('sync.reconnect')}
              </Button>
            )}
            <Button onClick={verify} loading={busy === 'verify'} disabled={paused || busy !== null}>
              {t('sync.verify')}
            </Button>
            <Button onClick={drill} loading={busy === 'drill'} disabled={paused || busy !== null}>
              {t('sync.drill')}
            </Button>
            <Button onClick={pause} loading={busy === 'pause'} disabled={busy !== null}>
              {paused ? t('sync.resume') : t('sync.pause')}
            </Button>
            {!needsReconnect && record && (
              <Button variant="plain" onClick={reconnect} disabled={busy !== null}>
                {record.kind === 's3' ? t('sync.editKeys') : t('sync.reconnect')}
              </Button>
            )}
          </div>
        )}

        {progress && (
          <div className={styles.section} role="status">
            <progress
              className={styles.meter}
              max={Math.max(progress.total, 1)}
              value={progress.done}
              aria-label={t('sync.verify')}
            />
            <p className={styles.note}>
              {progress.total > 0 ? t('common.progress', progress) : t('sync.verifyListing')}
            </p>
          </div>
        )}
        {report && (
          <div className={styles.section}>
            <p className={styles[report.tone]} role="status">
              {report.text}
            </p>
            {report.lines && <pre className={styles.code}>{report.lines.join('\n')}</pre>}
          </div>
        )}
        <p className={styles.note}>{t('sync.drillHint')}</p>
        {error && (
          <p className={styles.bad} role="alert">
            {error}
          </p>
        )}

        {confirmRemove ? (
          <div className={styles.section}>
            <p className={styles.warn}>{t('sync.removeBody')}</p>
            <div className={styles.actions}>
              <Button variant="danger" onClick={remove} loading={busy === 'remove'}>
                {t('sync.removeConfirm')}
              </Button>
              <Button onClick={() => setConfirmRemove(false)}>{t('common.cancel')}</Button>
            </div>
          </div>
        ) : (
          <div className={styles.actions}>
            <Button variant="danger" onClick={() => setConfirmRemove(true)}>
              {t('sync.remove')}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  )
}
