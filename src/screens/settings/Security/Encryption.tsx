import { useEffect, useState } from 'react'
import type { Runtime } from '../../../app/workspaceContext.tsx'
import { PASSPHRASE_MIN_LENGTH } from '../../../core/crypto/keyring'
import { passwordAsPassphrase } from '../../../core/crypto/password'
import type { SealReport } from '../../../core/crypto/sealer'
import type { SyncEngineImpl } from '../../../core/sync/engine'
import { useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { Segmented } from '../../../ui/components/Segmented.tsx'
import { useGuardStore } from '../../../ui/PasswordGate.tsx'
import { noteError } from '../Diagnostic/recent.ts'
import { commit } from '../Sync/connect.ts'
import { useAction } from '../Sync/hooks.tsx'
import {
  buildRemote,
  type DestRecord,
  keyringFor,
  passwordSeals,
  saveRecord,
  setPasswordSeals,
} from '../Sync/registry.ts'
import styles from '../Sync/settings.module.css'

type Lock = 'password' | 'passphrase'

/**
 * Encryption, under the password: an S3 backup is copied to an encrypted one, locked with the app password or a
 * separate passphrase, either known only to the student. Each backup's own state on the Sync page says whether it
 * is encrypted. `guardTick` changes when the password is set or removed above.
 */
export function EncryptionSection({
  rt,
  engine,
  records,
  reload,
  guardTick,
  onSealed,
}: {
  rt: Runtime
  engine: SyncEngineImpl | null
  records: DestRecord[] | null
  reload: () => void
  guardTick: number
  onSealed: () => void
}) {
  const t = useT()
  const guard = useGuardStore()
  const { busy, error, run } = useAction()
  const [hasPassword, setHasPassword] = useState(false)
  const [lock, setLock] = useState<Lock>('passphrase')
  const [chosen, setChosen] = useState('')
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [refused, setRefused] = useState<'wrong' | 'short' | null>(null)
  const [report, setReport] = useState<(SealReport & { label: string }) | null>(null)

  // The app password is the simple path whenever there is one.
  useEffect(() => {
    void guardTick
    guard
      .isSet()
      .then((set) => {
        setHasPassword(set)
        setLock(set ? 'password' : 'passphrase')
      })
      .catch((e: unknown) => noteError('guard.load', e))
  }, [guard, guardTick])

  const all = records ?? []
  const sealable = all.filter((r): r is Extract<DestRecord, { kind: 's3' }> => r.kind === 's3' && !r.sealed)
  const source = sealable.find((r) => r.id === chosen) ?? sealable[0]
  const withPassword = hasPassword && lock === 'password'
  const mismatch = again !== '' && again !== pass
  const tooShort = pass !== '' && pass.length < PASSPHRASE_MIN_LENGTH
  const ready = withPassword ? pass.length > 0 : pass.length >= PASSPHRASE_MIN_LENGTH && pass === again

  const choose = (l: Lock) => {
    setLock(l)
    setPass('')
    setAgain('')
    setRefused(null)
  }

  const seal = () =>
    run('seal', async () => {
      if (!source || !engine) return
      if (withPassword) {
        const use = await passwordAsPassphrase(guard, pass)
        if (use !== 'ok') return setRefused(use)
      }
      const { createSealer, sealDestination } = await import('../../../core/crypto/sealer')
      const from = await buildRemote(rt, source)
      const draft = {
        ...source,
        prefix: `${source.prefix || 'cursus'}-sealed`,
        label: `${source.label} · ${t('common.sealed')}`,
        sealed: true,
        paused: false,
      }
      const target = await buildRemote(rt, { ...draft, id: '' })
      if (!from || !target) throw new Error(t('sync.sealUnavailable'))
      const keyring = keyringFor(rt, target.id)
      const keyFile = await keyring.create(pass)
      const r = await sealDestination({ source: from, target, keyring, sealer: createSealer(rt.rng), keyFile })
      setReport({ ...r, label: source.label })
      if (!r.ok) return
      await commit(rt, engine, { ...draft, id: target.id })
      // Remembered on this device only: changing the password then adds a key file for the new one.
      if (withPassword) await setPasswordSeals(rt, [...(await passwordSeals(rt)), target.id])
      // Nothing new goes to the plaintext root any more; what is already there stays until the user deletes it.
      if (engine.destIds().includes(source.id)) engine.setPaused(source.id, true)
      await saveRecord(rt, { ...source, paused: true })
      setPass('')
      setAgain('')
      reload()
      onSealed()
    })

  return (
    <section id="encryption" className={styles.section} aria-labelledby="security-encryption">
      <h2 id="security-encryption" className={styles.sectionTitle}>
        {t('common.setSeal')}
      </h2>
      <p className={styles.prose}>{t('common.sealBody')}</p>
      {sealable.length === 0 ? (
        <p className={styles.note}>{all.length === 0 ? t('sync.sealNoDestination') : t('sync.sealNothingToSeal')}</p>
      ) : (
        <form
          className={styles.card}
          onSubmit={(e) => {
            e.preventDefault()
            void seal()
          }}
        >
          <h3 className={styles.sectionTitle}>{t('sync.sealTitle')}</h3>
          <label className={styles.section}>
            <span className={styles.label}>{t('sync.sealWhich')}</span>
            <select className={styles.select} value={source?.id ?? ''} onChange={(e) => setChosen(e.target.value)}>
              {sealable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          {hasPassword ? (
            <Segmented<Lock>
              label={t('sync.sealLockWith')}
              options={[
                { value: 'password', label: t('sync.sealWithPassword') },
                { value: 'passphrase', label: t('sync.sealWithPassphrase') },
              ]}
              value={lock}
              onChange={choose}
            />
          ) : (
            <p className={styles.note}>{t('sync.sealPasswordFirst', { count: PASSPHRASE_MIN_LENGTH })}</p>
          )}
          {withPassword ? (
            <>
              <Field
                label={t('settings.guardPassword')}
                hint={t('sync.sealPasswordHint', { count: PASSPHRASE_MIN_LENGTH })}
                type="password"
                autoComplete="current-password"
                value={pass}
                onChange={(e) => {
                  setPass(e.target.value)
                  setRefused(null)
                }}
                error={
                  refused === 'wrong'
                    ? t('settings.guardWrong')
                    : refused === 'short'
                      ? t('sync.sealPasswordShort', { count: PASSPHRASE_MIN_LENGTH })
                      : undefined
                }
              />
              <p className={styles.warn}>{t('sync.sealPasswordLoss')}</p>
            </>
          ) : (
            <>
              <Field
                label={t('sync.passphrase')}
                hint={t('sync.passphraseHint')}
                type="password"
                autoComplete="new-password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                error={tooShort ? t('sync.sealTooShort', { count: PASSPHRASE_MIN_LENGTH }) : undefined}
              />
              <Field
                label={t('sync.sealAgain')}
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                error={mismatch ? t('sync.sealMismatch') : undefined}
              />
            </>
          )}
          <p className={styles.warn}>{t('sync.sealPlaintextStays')}</p>
          <p className={styles.note}>{withPassword ? t('sync.sealPasswordHowItWorks') : t('sync.sealHowItWorks')}</p>
          <div className={styles.actions}>
            <Button type="submit" variant="primary" loading={busy === 'seal'} disabled={!ready || busy !== null}>
              {t('sync.sealAction')}
            </Button>
          </div>
        </form>
      )}

      {report && (
        <p className={report.ok ? styles.ok : styles.bad} role="status">
          {report.ok
            ? t('sync.sealDone', { count: report.copied, name: report.label })
            : t('sync.sealIncomplete', {
                count:
                  report.unreadable.length + report.deferred.length + report.missing.length + report.corrupt.length,
              })}
        </p>
      )}
      {error && (
        <p className={styles.bad} role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
