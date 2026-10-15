import { type FormEvent, useState } from 'react'
import { useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { Segmented } from '../../../ui/components/Segmented.tsx'
import { appFolderDraft } from './builtIn.ts'
import { redirectUri } from './connect.ts'
import { errorText } from './hooks.tsx'
import type { DestDraft } from './registry.ts'
import styles from './settings.module.css'

interface FormProps {
  /** Saves (and, for OAuth providers, leaves for the consent page). */
  onSubmit: (d: DestDraft) => Promise<void>
}

function useSubmit(onSubmit: FormProps['onSubmit']) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = (make: () => DestDraft) => async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit(make())
    } catch (err) {
      setError(errorText(t, err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, submit }
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className={styles.bad} role="alert">
      {error}
    </p>
  ) : null
}

export function DriveForm({ onSubmit }: FormProps) {
  const t = useT()
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [rootName, setRootName] = useState('Cursus')
  const { busy, error, submit } = useSubmit(onSubmit)
  return (
    <form
      className={styles.form}
      onSubmit={submit(() => ({
        kind: 'gdrive',
        label: `Google Drive · ${rootName.trim()}`,
        rootName: rootName.trim(),
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        secretName: `gdrive:${rootName.trim()}`,
      }))}
    >
      <p className={styles.prose}>{t('sync.driveHelp')}</p>
      <Field
        label={t('sync.clientId')}
        autoComplete="off"
        spellCheck={false}
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
        required
      />
      <Field
        label={t('sync.clientSecret')}
        hint={t('sync.clientSecretHint')}
        type="password"
        autoComplete="off"
        value={clientSecret}
        onChange={(e) => setClientSecret(e.target.value)}
      />
      <Field label={t('sync.folderName')} value={rootName} onChange={(e) => setRootName(e.target.value)} required />
      <ErrorLine error={error} />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={busy} disabled={!clientId.trim() || !rootName.trim()}>
          {t('sync.connect')}
        </Button>
      </div>
    </form>
  )
}

/** The callback page to register with a provider, exactly, with a button that copies it. */
function RedirectUri({ help }: { help: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const uri = redirectUri()
  return (
    <div className={styles.section}>
      <p className={styles.prose}>{help}</p>
      <code className={styles.uri} data-testid="redirect-uri">
        {uri}
      </code>
      <div className={styles.actions}>
        <Button
          variant="plain"
          onClick={async () => {
            setError(null)
            try {
              await navigator.clipboard.writeText(uri)
              setCopied(true)
            } catch (err) {
              setError(errorText(t, err))
            }
          }}
        >
          {copied ? t('sync.copied') : t('sync.copyUri')}
        </Button>
      </div>
      <ErrorLine error={error} />
    </div>
  )
}

/** Dropbox or OneDrive with the student's own app: only its public id, no secret (PKCE). */
function AppFolderForm({ kind, onSubmit }: FormProps & { kind: 'dropbox' | 'onedrive' }) {
  const t = useT()
  const [clientId, setClientId] = useState('')
  const [root, setRoot] = useState('')
  const { busy, error, submit } = useSubmit(onSubmit)
  const dropbox = kind === 'dropbox'
  return (
    <form className={styles.form} onSubmit={submit(() => appFolderDraft(kind, clientId, root))}>
      <p className={styles.prose}>{dropbox ? t('sync.dropboxHelp') : t('sync.onedriveHelp')}</p>
      <p className={styles.prose}>{dropbox ? t('sync.dropboxKeyOnly') : t('sync.onedriveKeyOnly')}</p>
      <RedirectUri help={dropbox ? t('sync.dropboxRedirect') : t('sync.onedriveRedirect')} />
      <Field
        label={dropbox ? t('sync.appKey') : t('sync.onedriveClientId')}
        autoComplete="off"
        spellCheck={false}
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
        required
      />
      <Field
        label={t('sync.subfolder')}
        hint={t('sync.subfolderHint')}
        autoComplete="off"
        value={root}
        onChange={(e) => setRoot(e.target.value)}
      />
      <ErrorLine error={error} />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={busy} disabled={!clientId.trim()}>
          {t('sync.connect')}
        </Button>
      </div>
    </form>
  )
}

export const DropboxForm = ({ onSubmit }: FormProps) => <AppFolderForm kind="dropbox" onSubmit={onSubmit} />
export const OneDriveForm = ({ onSubmit }: FormProps) => <AppFolderForm kind="onedrive" onSubmit={onSubmit} />

export function CloudKitForm({ onSubmit }: FormProps) {
  const t = useT()
  const [container, setContainer] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [environment, setEnvironment] = useState<'production' | 'development'>('production')
  const { busy, error, submit } = useSubmit(onSubmit)
  return (
    <form
      className={styles.form}
      onSubmit={submit(() => ({
        kind: 'cloudkit',
        label: `iCloud · ${container.trim()}`,
        container: container.trim(),
        environment,
        apiToken: apiToken.trim(),
      }))}
    >
      <p className={styles.prose}>{t('sync.cloudkitHelp')}</p>
      <Field
        label={t('sync.container')}
        placeholder="iCloud.com.example.cursus"
        autoComplete="off"
        spellCheck={false}
        value={container}
        onChange={(e) => setContainer(e.target.value)}
        required
      />
      <Field
        label={t('sync.apiToken')}
        autoComplete="off"
        spellCheck={false}
        value={apiToken}
        onChange={(e) => setApiToken(e.target.value)}
        required
      />
      <Segmented
        label={t('sync.environment')}
        value={environment}
        onChange={setEnvironment}
        options={[
          { value: 'production', label: t('sync.envProduction') },
          { value: 'development', label: t('sync.envDevelopment') },
        ]}
      />
      <ErrorLine error={error} />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={busy} disabled={!container.trim() || !apiToken.trim()}>
          {t('sync.connect')}
        </Button>
      </div>
    </form>
  )
}

export function FolderForm({
  kind,
  supported,
  onPick,
}: {
  kind: 'folder' | 'icloud'
  supported: boolean
  onPick: (label: string) => Promise<void>
}) {
  const t = useT()
  const [label, setLabel] = useState(kind === 'icloud' ? 'iCloud Drive · Cursus' : 'Cursus')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!supported) return <p className={styles.prose}>{t('sync.folderUnsupported')}</p>
  return (
    <form
      className={styles.form}
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
          await onPick(label.trim())
        } catch (err) {
          setError(errorText(t, err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <p className={styles.prose}>{kind === 'icloud' ? t('sync.icloudHelp') : t('sync.folderHelp')}</p>
      <Field label={t('sync.folderLabel')} value={label} onChange={(e) => setLabel(e.target.value)} required />
      <ErrorLine error={error} />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={busy} disabled={!label.trim()}>
          {t('sync.chooseFolder')}
        </Button>
      </div>
    </form>
  )
}
