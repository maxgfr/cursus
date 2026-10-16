import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { paths } from '../../../app/routes.ts'
import { formatDate } from '../../../i18n/format.ts'
import { useLocale, useT } from '../../../i18n/react.tsx'
import { Button, buttonClass } from '../../../ui/components/Button.tsx'
import { ListGroup, ListRow } from '../../../ui/components/List.tsx'
import { dumpDatabase, localDatabases } from '../Recovery/rawExport.ts'
import { useAction, useDestinations } from '../Sync/hooks.tsx'
import { type DestRecord, download, fileStamp } from '../Sync/registry.ts'
import styles from '../Sync/settings.module.css'

/** Where a destination lives, without any secret: enough to find it again from a new device. */
function whereIs(r: DestRecord): string {
  switch (r.kind) {
    case 's3':
      return `${r.endpoint} · ${r.bucket}${r.prefix ? `/${r.prefix}` : ''}`
    case 'gdrive':
      return `Google Drive · ${r.rootName}`
    case 'dropbox':
      return `Dropbox · Apps/Cursus${r.root ? `/${r.root}` : ''}`
    case 'onedrive':
      return `OneDrive · Apps/Cursus${r.root ? `/${r.root}` : ''}`
    case 'cloudkit':
      return `CloudKit · ${r.container} (${r.environment})`
    default:
      return r.label
  }
}

/**
 * How to get the library back: from a backup or a file, the printable recovery sheet (where it lives, without any
 * key), and, for experts and support, the raw databases this browser keeps.
 */
export function RecoverySections() {
  const t = useT()
  const locale = useLocale()
  const { rt, engine, records } = useDestinations()
  const { busy, error, run } = useAction()
  const [dbs, setDbs] = useState<string[] | null>(null)
  const [ids, setIds] = useState<{ device: string; workspace: string | null } | null>(null)

  useEffect(() => {
    let live = true
    void localDatabases().then((d) => {
      if (live) setDbs(d)
    })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    let live = true
    void (async () => {
      const device = await rt.log.deviceId()
      const workspace = engine ? await engine.workspaceId() : null
      if (live) setIds({ device, workspace })
    })()
    return () => {
      live = false
    }
  }, [rt, engine])

  return (
    <>
      <section className={styles.card} aria-labelledby="rec-restore">
        <h2 id="rec-restore" className={styles.sectionTitle}>
          {t('settings.recRestoreTitle')}
        </h2>
        <p className={styles.prose}>{t('settings.recRestoreBody')}</p>
        <div className={styles.actions}>
          <Link href={paths.settingsSync} className={buttonClass({ variant: 'primary' })}>
            {t('settings.sync')}
          </Link>
          <Link href={paths.settingsData} className={buttonClass()}>
            {t('common.setData')}
          </Link>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="rec-sheet">
        <div className={styles.printable}>
          <h2 id="rec-sheet" className={styles.sectionTitle}>
            {t('settings.recSheetTitle')}
          </h2>
          <p className={styles.prose}>{t('settings.recSheetBody')}</p>
          <dl className={styles.facts}>
            <dt>{t('settings.recPrinted')}</dt>
            <dd>{formatDate(locale, rt.clock.now(), 'long')}</dd>
            <dt>{t('settings.recWorkspace')}</dt>
            <dd translate="no">{ids?.workspace ?? '—'}</dd>
            <dt>{t('settings.recDevice')}</dt>
            <dd translate="no">{ids?.device ?? '—'}</dd>
          </dl>
          {(records ?? []).length === 0 ? (
            <p className={styles.warn}>{t('settings.recNoDest')}</p>
          ) : (
            <dl className={styles.facts}>
              {(records ?? []).map((r) => (
                <div key={r.id} style={{ display: 'contents' }}>
                  <dt>{r.label}</dt>
                  <dd>
                    {whereIs(r)}
                    {r.sealed ? ` · ${t('common.sealed')}` : ''}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <p className={styles.prose}>
            {t('sync.passphrase')}: <span className={styles.blank} />
          </p>
          <p className={styles.note}>{t('settings.recSheetNote')}</p>
        </div>
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => window.print()}>
            {t('settings.recPrint')}
          </Button>
        </div>
      </section>

      {/* For experts and support: the raw databases this browser keeps. */}
      <details className={styles.advanced}>
        <summary>{t('sync.advanced')}</summary>
        <ListGroup title={t('settings.recDatabases')} footer={t('settings.recDatabasesFooter')}>
          {(dbs ?? []).map((name) => (
            <ListRow
              key={name}
              title={<span translate="no">{name}</span>}
              subtitle={name === 'cursus-v1' ? t('settings.recCurrent') : t('settings.recKept')}
              trailing={
                <Button
                  variant="plain"
                  loading={busy === name}
                  aria-label={t('settings.recExportOf', { name })}
                  onClick={() =>
                    void run(name, async () => {
                      download(
                        await dumpDatabase(name),
                        `${name}-${fileStamp(rt.clock.now())}.json`,
                        'application/json',
                      )
                    })
                  }
                >
                  {t('settings.recExport')}
                </Button>
              }
            />
          ))}
        </ListGroup>
      </details>
      {error && (
        <p className={styles.bad} role="alert">
          {error}
        </p>
      )}
    </>
  )
}
