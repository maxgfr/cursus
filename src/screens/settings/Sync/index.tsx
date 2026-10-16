import {
  Box,
  Cloud,
  CloudCog,
  FileArchive,
  FolderOpen,
  GitBranch,
  HardDrive,
  Server,
  Smartphone,
  Triangle,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useSearch } from 'wouter'
import { paths } from '../../../app/routes.ts'
import { useT } from '../../../i18n/react.tsx'
import { ProtectionBadge, SyncBadge } from '../../../ui/components/Badges.tsx'
import { Banner } from '../../../ui/components/Banner.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { ListGroup, ListRow } from '../../../ui/components/List.tsx'
import { Sheet } from '../../../ui/components/Sheet.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import { noteError } from '../Diagnostic/recent.ts'
import { UpdateControl } from '../Diagnostic/update.tsx'
import { oneClickDraft } from './builtIn.ts'
import { beginOAuth, cloudkitSignIn, commit, folderSupported, isOAuth, pickFolder } from './connect.ts'
import { DestSheet, stateText } from './DestSheet.tsx'
import { EncryptionSection } from './Encryption.tsx'
import { GitHubForm } from './GitHubForm.tsx'
import { errorText, useAction, useDestinations, useWorkspaceConfirm } from './hooks.tsx'
import { CloudKitForm, DriveForm, DropboxForm, FolderForm, OneDriveForm } from './ProviderForms.tsx'
import { recommended, thisDevice } from './pick.ts'
import { type DestDraft, DestinationError, type DestKind, syncNow } from './registry.ts'
import { S3Form } from './S3Form.tsx'
import styles from './settings.module.css'

const ICON = 20

interface Kind {
  kind: DestKind
  title: string
  subtitle: string
  icon: ReactNode
}

export default function SyncSettings() {
  const t = useT()
  const { rt, status, summary, engine, scheduler, error: engineError, records, reload, oauth } = useDestinations()
  const confirmSheet = useWorkspaceConfirm()
  const oauthError = oauth && 'error' in oauth ? oauth.error : null
  // The screen says it plainly; the technical cause waits in Diagnostics.
  useEffect(() => {
    if (oauthError !== null && !(oauthError instanceof DestinationError)) noteError('sync.oauth', oauthError)
  }, [oauthError])
  const { busy, error, run } = useAction()
  const [adding, setAdding] = useState<DestKind | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [connected, setConnected] = useState<string | null>(null)
  const dests = status?.dests ?? []
  // An older link to the Encryption page lands here (`?at=encryption`): the section is brought into view.
  const at = new URLSearchParams(useSearch()).get('at')
  const hasDests = dests.length > 0
  useEffect(() => {
    if (at === 'encryption' && hasDests) document.getElementById('encryption')?.scrollIntoView({ block: 'start' })
  }, [at, hasDests])

  const ready = engine !== null && scheduler !== null

  const added = async (label: string) => {
    setAdding(null)
    setConnected(label)
    reload()
    scheduler?.trigger('manual')
  }

  const submitOAuth = async (d: DestDraft) => {
    if (!engine) return
    if (isOAuth(d)) {
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

  const device = useMemo(thisDevice, [])
  const best = recommended(device)
  // Everyday choices first, each saying where it works; the technical ones wait behind Advanced.
  const everyday: Kind[] = [
    {
      kind: 'icloud',
      title: t('sync.icloud'),
      subtitle: t(device.folders ? 'sync.icloudSub' : 'sync.icloudSubOff'),
      icon: <Cloud size={ICON} />,
    },
    {
      kind: 'gdrive',
      title: t('sync.googleDrive'),
      subtitle: `${t('sync.gdriveSub')} ${t('sync.ownAppKey')}`,
      icon: <Triangle size={ICON} />,
    },
    {
      kind: 'dropbox',
      title: t('sync.dropbox'),
      subtitle: oneClickDraft('dropbox') ? t('sync.dropboxSub') : `${t('sync.dropboxSub')} ${t('sync.ownAppKey')}`,
      icon: <Box size={ICON} />,
    },
    {
      kind: 'onedrive',
      title: t('sync.onedrive'),
      subtitle: oneClickDraft('onedrive') ? t('sync.onedriveSub') : `${t('sync.onedriveSub')} ${t('sync.ownAppKey')}`,
      icon: <HardDrive size={ICON} />,
    },
    { kind: 'github', title: t('sync.github'), subtitle: t('sync.githubSub'), icon: <GitBranch size={ICON} /> },
  ]
  const advanced: Kind[] = [
    { kind: 's3', title: t('sync.s3'), subtitle: t('sync.s3Sub'), icon: <Server size={ICON} /> },
    { kind: 'cloudkit', title: t('sync.cloudkit'), subtitle: t('sync.cloudkitSub'), icon: <CloudCog size={ICON} /> },
    { kind: 'folder', title: t('sync.folder'), subtitle: t('sync.folderSub'), icon: <FolderOpen size={ICON} /> },
  ]
  const kinds = [...everyday, ...advanced]
  const addingTitle = kinds.find((k) => k.kind === adding)?.title ?? ''
  const row = (k: Kind) => (
    <ListRow
      key={k.kind}
      leading={k.icon}
      title={k.title}
      subtitle={k.subtitle}
      trailing={k.kind === best ? <span className={styles.recommended}>{t('sync.recommended')}</span> : undefined}
      onClick={() => {
        // With Cursus's own app key, the provider's consent page is one tap away; otherwise the form asks for one.
        const quick = oneClickDraft(k.kind)
        if (quick && engine) void run('oauth', () => submitOAuth(quick))
        else setAdding(k.kind)
      }}
      chevron
    />
  )
  const openStatus = dests.find((d) => d.id === open)

  return (
    <Screen title={t('settings.sync')} back={paths.settings}>
      <div className={styles.stack}>
        {status?.alarm && <Banner title={t('sync.alarmTitle')} body={t('sync.alarmBody')} />}
        {/* Nothing is at risk: the changes are kept and applied after the update, offered right here. */}
        {(status?.needsUpgrade ?? 0) > 0 && (
          <section className={styles.card} aria-labelledby="sync-upgrade">
            <h2 id="sync-upgrade" className={styles.sectionTitle}>
              {t('sync.upgradeTitle')}
            </h2>
            <p className={styles.prose}>{t('sync.upgradeBody', { count: status?.needsUpgrade ?? 0 })}</p>
            <UpdateControl waitingChanges />
          </section>
        )}
        {engineError !== null && (
          <p className={styles.bad} role="alert">
            {t('sync.engineError')}
          </p>
        )}

        <section className={styles.section} aria-labelledby="sync-summary">
          <h2 id="sync-summary" className="sr-only">
            {t('sync.summaryTitle')}
          </h2>
          <div className={styles.summaryRow}>
            <SyncBadge summary={summary} />
            <p className={styles.prose} data-testid="sync-summary">
              {dests.length === 0
                ? t('sync.summaryNone')
                : summary.kind === 'protected'
                  ? t('sync.summaryProtected', { count: summary.count })
                  : summary.kind === 'offline'
                    ? t('sync.summaryOffline')
                    : t('sync.summaryPending')}
            </p>
          </div>
          {oauth && 'label' in oauth && (
            <p className={styles.ok} role="status">
              {t('sync.connected', { name: oauth.label })}
            </p>
          )}
          {oauth && 'error' in oauth && (
            <p className={styles.bad} role="alert">
              {oauth.error instanceof DestinationError ? errorText(t, oauth.error) : t('sync.oauthFailed')}
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

        {/* With no destination, the status line above says it all; "Add destination" leads the list. */}
        {dests.length > 0 && (
          <ListGroup title={t('sync.destinations')}>
            {dests.map((d) => (
              <ListRow
                key={d.id}
                title={d.label}
                subtitle={stateText(t, d)}
                trailing={
                  records ? <ProtectionBadge sealed={records.find((r) => r.id === d.id)?.sealed === true} /> : undefined
                }
                onClick={() => setOpen(d.id)}
                chevron
              />
            ))}
          </ListGroup>
        )}

        {/* Sends the backups to another device, or receives them on a new one: offered with or without backups. */}
        <ListGroup title={t('sync.otherDevices')}>
          <ListRow
            leading={<Smartphone size={ICON} />}
            title={t('sync.pairDevice')}
            subtitle={t('sync.nearbySub')}
            href={paths.settingsPair}
          />
        </ListGroup>

        <ListGroup title={t('sync.addDestination')} footer={t('sync.addFooter')}>
          {everyday.map(row)}
          {/* Works everywhere, with nothing to set up: first choice where iCloud Drive can't be kept in sync. */}
          <ListRow
            leading={<FileArchive size={ICON} />}
            title={t('sync.file')}
            subtitle={t('sync.fileSub')}
            href={paths.settingsData}
            trailing={best === 'file' ? <span className={styles.recommended}>{t('sync.recommended')}</span> : undefined}
          />
        </ListGroup>
        <details className={styles.advanced}>
          <summary>{t('sync.advanced')}</summary>
          <ListGroup title={t('sync.advanced')} hideTitle>
            {advanced.map(row)}
          </ListGroup>
        </details>

        {dests.length > 0 && <EncryptionSection rt={rt} engine={engine} records={records} reload={reload} />}
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
        ) : adding === 'github' ? (
          <GitHubForm
            onSave={async (r) => {
              const rec = await commit(rt, engine, r)
              await added(rec.label)
            }}
          />
        ) : adding === 'gdrive' ? (
          <DriveForm onSubmit={submitOAuth} />
        ) : adding === 'dropbox' ? (
          <DropboxForm onSubmit={submitOAuth} />
        ) : adding === 'onedrive' ? (
          <OneDriveForm onSubmit={submitOAuth} />
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
