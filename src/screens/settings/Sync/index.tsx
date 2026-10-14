import { Cloud, CloudUpload, Folder, HardDrive, Server } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { paths } from '../../../app/routes.ts'
import { useT } from '../../../i18n/react.tsx'
import { SyncBadge } from '../../../ui/components/Badges.tsx'
import { Banner } from '../../../ui/components/Banner.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { EmptyState } from '../../../ui/components/EmptyState.tsx'
import { ListGroup, ListRow } from '../../../ui/components/List.tsx'
import { Sheet } from '../../../ui/components/Sheet.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import { beginOAuth, cloudkitSignIn, commit, folderSupported, pickFolder } from './connect.ts'
import { DestSheet, stateText } from './DestSheet.tsx'
import { errorText, useAction, useDestinations, useWorkspaceConfirm } from './hooks.tsx'
import { CloudKitForm, DriveForm, DropboxForm, FolderForm } from './ProviderForms.tsx'
import { type DestDraft, type DestKind, syncNow } from './registry.ts'
import { S3Form } from './S3Form.tsx'
import styles from './settings.module.css'

const ICON = 20

export default function SyncSettings() {
  const t = useT()
  const { rt, status, summary, engine, scheduler, error: engineError, records, reload, oauth } = useDestinations()
  const confirmSheet = useWorkspaceConfirm()
  const { busy, error, run } = useAction()
  const [adding, setAdding] = useState<DestKind | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [connected, setConnected] = useState<string | null>(null)
  const dests = status?.dests ?? []

  const ready = engine !== null && scheduler !== null

  const added = async (label: string) => {
    setAdding(null)
    setConnected(label)
    reload()
    scheduler?.trigger('manual')
  }

  const submitOAuth = async (d: DestDraft) => {
    if (!engine) return
    if (d.kind === 'gdrive' || d.kind === 'dropbox') {
      location.assign(await beginOAuth(rt, d))
      return
    }
    const rec = await commit(rt, engine, d)
    if (rec.kind === 'cloudkit') {
      const url = await cloudkitSignIn(rt, rec)
      if (url) {
        location.assign(url)
        return
      }
    }
    await added(rec.label)
  }

  const kinds: { kind: DestKind; title: string; icon: ReactNode }[] = [
    { kind: 's3', title: t('sync.s3'), icon: <Server size={ICON} /> },
    { kind: 'gdrive', title: t('sync.googleDrive'), icon: <Cloud size={ICON} /> },
    { kind: 'dropbox', title: t('sync.dropbox'), icon: <CloudUpload size={ICON} /> },
    { kind: 'cloudkit', title: t('sync.cloudkit'), icon: <Cloud size={ICON} /> },
    { kind: 'icloud', title: t('sync.icloud'), icon: <Folder size={ICON} /> },
    { kind: 'folder', title: t('sync.folder'), icon: <HardDrive size={ICON} /> },
  ]
  const addingTitle = kinds.find((k) => k.kind === adding)?.title ?? ''
  const openStatus = dests.find((d) => d.id === open)

  return (
    <Screen title={t('settings.sync')} back={paths.settings} trailing={<SyncBadge summary={summary} />}>
      <div className={styles.stack}>
        {status?.alarm && <Banner title={t('sync.alarmTitle')} body={t('sync.alarmBody')} />}
        {(status?.needsUpgrade ?? 0) > 0 && (
          <Banner
            title={t('sync.upgradeTitle')}
            body={t('sync.upgradeBody', { count: status?.needsUpgrade ?? 0 })}
            action={<Button onClick={() => location.reload()}>{t('common.reload')}</Button>}
          />
        )}
        {engineError !== null && (
          <p className={styles.bad} role="alert">
            {t('sync.engineError', { error: engineError instanceof Error ? engineError.message : String(engineError) })}
          </p>
        )}

        <section className={styles.section} aria-labelledby="sync-summary">
          <h2 id="sync-summary" className="sr-only">
            {t('sync.summaryTitle')}
          </h2>
          <p className={styles.prose} data-testid="sync-summary">
            {dests.length === 0
              ? t('sync.summaryNone')
              : summary.kind === 'protected'
                ? t('sync.summaryProtected', { count: summary.count })
                : summary.kind === 'offline'
                  ? t('sync.summaryOffline')
                  : t('sync.summaryPending')}
          </p>
          {oauth && 'label' in oauth && (
            <p className={styles.ok} role="status">
              {t('sync.connected', { name: oauth.label })}
            </p>
          )}
          {oauth && 'error' in oauth && (
            <p className={styles.bad} role="alert">
              {t('sync.oauthFailed', { error: errorText(t, oauth.error) })}
            </p>
          )}
          {connected && (
            <p className={styles.ok} role="status">
              {t('sync.connected', { name: connected })}
            </p>
          )}
          {error && (
            <p className={styles.bad} role="alert">
              {error}
            </p>
          )}
          {dests.length > 0 && (
            <div className={styles.actions}>
              <Button
                variant="primary"
                loading={busy === 'sync'}
                disabled={!ready}
                onClick={() =>
                  void run('sync', async () => {
                    if (engine && scheduler) await syncNow(rt, engine, scheduler)
                  })
                }
              >
                {t('sync.syncNow')}
              </Button>
            </div>
          )}
        </section>

        {dests.length === 0 ? (
          <EmptyState icon={Cloud} title={t('common.syncEmpty')} />
        ) : (
          <ListGroup title={t('sync.destinations')}>
            {dests.map((d) => (
              <ListRow key={d.id} title={d.label} subtitle={stateText(t, d)} onClick={() => setOpen(d.id)} chevron />
            ))}
          </ListGroup>
        )}

        <ListGroup title={t('sync.addDestination')} footer={t('sync.addFooter')}>
          {kinds.map((k) => (
            <ListRow key={k.kind} leading={k.icon} title={k.title} onClick={() => setAdding(k.kind)} chevron />
          ))}
          <ListRow leading={<HardDrive size={ICON} />} title={t('sync.file')} href={paths.settingsData} />
        </ListGroup>
      </div>

      <Sheet open={adding !== null} title={addingTitle} onClose={() => setAdding(null)}>
        {!ready ? (
          <p className={styles.prose}>{t('common.loading')}</p>
        ) : adding === 's3' ? (
          <S3Form
            onSave={async (r) => {
              const rec = await commit(rt, engine, r)
              await added(rec.label)
            }}
          />
        ) : adding === 'gdrive' ? (
          <DriveForm onSubmit={submitOAuth} />
        ) : adding === 'dropbox' ? (
          <DropboxForm onSubmit={submitOAuth} />
        ) : adding === 'cloudkit' ? (
          <CloudKitForm onSubmit={submitOAuth} />
        ) : adding === 'folder' || adding === 'icloud' ? (
          <FolderForm
            kind={adding}
            supported={folderSupported()}
            onPick={async (label) => {
              const rec = await pickFolder(rt, engine, adding, label)
              await added(rec.label)
            }}
          />
        ) : null}
      </Sheet>

      {openStatus && engine && scheduler && (
        <DestSheet
          rt={rt}
          engine={engine}
          scheduler={scheduler}
          status={openStatus}
          record={records?.find((r) => r.id === openStatus.id)}
          onClose={() => setOpen(null)}
          onChanged={reload}
        />
      )}
      {confirmSheet}
    </Screen>
  )
}
