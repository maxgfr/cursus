import { useState } from 'react'
import type { S3Diagnosis } from '../../../core/sync/providers/s3'
import { useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { Segmented } from '../../../ui/components/Segmented.tsx'
import { errorText } from './hooks.tsx'
import type { DestRecord } from './registry.ts'
import styles from './settings.module.css'

type S3Record = Extract<DestRecord, { kind: 's3' }>
type Flavour = 'aws' | 'r2' | 'minio' | 'b2'

export interface S3FormProps {
  /** Reconnecting: the destination's current settings (its identity fields stay as they are). */
  initial?: S3Record
  onSave: (r: Omit<S3Record, 'id'>) => Promise<void>
}

/** Endpoint, bucket and keys, with a connection test that says which part is wrong (CORS help included). */
export function S3Form({ initial, onSave }: S3FormProps) {
  const t = useT()
  const [v, setV] = useState({
    endpoint: initial?.endpoint ?? '',
    region: initial?.region ?? 'us-east-1',
    bucket: initial?.bucket ?? '',
    prefix: initial?.prefix ?? 'cursus',
    accessKeyId: initial?.accessKeyId ?? '',
    secretAccessKey: initial?.secretAccessKey ?? '',
  })
  const [result, setResult] = useState<S3Diagnosis | null>(null)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [flavour, setFlavour] = useState<Flavour>('aws')
  const [cors, setCors] = useState<Record<Flavour, string> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => {
    setV((x) => ({ ...x, [k]: e.target.value }))
    setResult(null)
  }
  const complete =
    v.endpoint.trim() !== '' && v.bucket.trim() !== '' && v.accessKeyId !== '' && v.secretAccessKey !== ''
  const record = (): Omit<S3Record, 'id'> => {
    const endpoint = v.endpoint.trim().replace(/\/+$/, '')
    const host = URL.canParse(endpoint) ? new URL(endpoint).host : endpoint
    return {
      kind: 's3',
      label: initial?.label ?? `${v.bucket.trim()} · ${host}`,
      endpoint,
      region: v.region.trim() || 'us-east-1',
      bucket: v.bucket.trim(),
      prefix: v.prefix.trim(),
      accessKeyId: v.accessKeyId.trim(),
      secretAccessKey: v.secretAccessKey,
      ...(initial?.paused ? { paused: true } : {}),
      ...(initial?.sealed ? { sealed: true } : {}),
    }
  }

  const test = async (): Promise<S3Diagnosis> => {
    const { s3Remote, corsConfigFor } = await import('../../../core/sync/providers/s3')
    const r = record()
    let d: S3Diagnosis
    try {
      new URL(r.endpoint)
      d = await s3Remote(r).diagnose()
    } catch (e) {
      d = { ok: false, problem: 'network', detail: e instanceof Error ? e.message : String(e) }
    }
    setResult(d)
    setCors(!d.ok && d.problem === 'cors' ? corsConfigFor(location.origin) : null)
    return d
  }

  const run = async (what: 'test' | 'save') => {
    setBusy(what)
    setError(null)
    try {
      const d = await test()
      if (what === 'save' && d.ok) await onSave(record())
    } catch (e) {
      setError(errorText(t, e))
    } finally {
      setBusy(null)
    }
  }

  const problem = (d: Extract<S3Diagnosis, { ok: false }>): string => {
    switch (d.problem) {
      case 'cors':
        return t('sync.s3Cors')
      case 'network':
        return t('sync.s3Network')
      case 'keys':
      case 'auth':
        return t('sync.s3Keys')
      case 'region':
        return d.region ? t('sync.s3RegionIs', { region: d.region }) : t('sync.s3Region')
      case 'bucket':
        return t('sync.s3Bucket')
      case 'permission':
        return t('sync.s3Permission')
      case 'clock-skew':
        return t('sync.s3Clock')
      default:
        return t('sync.s3Other')
    }
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault()
        void run('save')
      }}
    >
      <Field
        label={t('sync.s3Endpoint')}
        hint={t('sync.s3EndpointHint')}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={v.endpoint}
        onChange={set('endpoint')}
        disabled={initial !== undefined}
        required
      />
      <div className={styles.grid}>
        <Field
          label={t('sync.s3BucketLabel')}
          autoComplete="off"
          spellCheck={false}
          value={v.bucket}
          onChange={set('bucket')}
          disabled={initial !== undefined}
          required
        />
        <Field label={t('sync.s3RegionLabel')} autoComplete="off" value={v.region} onChange={set('region')} />
      </div>
      <Field
        label={t('sync.s3Prefix')}
        hint={t('sync.s3PrefixHint')}
        autoComplete="off"
        spellCheck={false}
        value={v.prefix}
        onChange={set('prefix')}
        disabled={initial !== undefined}
      />
      <div className={styles.grid}>
        <Field
          label={t('sync.s3AccessKey')}
          autoComplete="off"
          spellCheck={false}
          value={v.accessKeyId}
          onChange={set('accessKeyId')}
          required
        />
        <Field
          label={t('sync.s3SecretKey')}
          type="password"
          autoComplete="off"
          value={v.secretAccessKey}
          onChange={set('secretAccessKey')}
          required
        />
      </div>
      <p className={styles.note}>{t('sync.s3KeysHint')}</p>
      {result?.ok && (
        <p className={styles.ok} role="status">
          {t('sync.testOk')}
        </p>
      )}
      {result && !result.ok && (
        <div className={styles.section}>
          <p className={styles.bad} role="alert">
            {problem(result)}
          </p>
          <p className={styles.note}>{result.detail}</p>
        </div>
      )}
      {cors && (
        <div className={styles.section}>
          <p className={styles.prose}>{t('sync.corsHelp', { origin: location.origin })}</p>
          <Segmented<Flavour>
            label={t('sync.corsProvider')}
            value={flavour}
            onChange={setFlavour}
            options={[
              { value: 'aws', label: 'AWS' },
              { value: 'r2', label: 'Cloudflare R2' },
              { value: 'minio', label: 'MinIO' },
              { value: 'b2', label: 'Backblaze B2' },
            ]}
          />
          <pre className={styles.code}>{cors[flavour]}</pre>
        </div>
      )}
      {error && (
        <p className={styles.bad} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button onClick={() => void run('test')} loading={busy === 'test'} disabled={!complete || busy !== null}>
          {t('sync.test')}
        </Button>
        <Button type="submit" variant="primary" loading={busy === 'save'} disabled={!complete || busy !== null}>
          {initial ? t('common.save') : t('sync.add')}
        </Button>
      </div>
    </form>
  )
}
