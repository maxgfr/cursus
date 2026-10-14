import { useState } from 'react'
import { paths } from '../../../app/routes.ts'
import type { SealReport } from '../../../core/crypto/sealer'
import { useT } from '../../../i18n/react.tsx'
import { ProtectionBadge } from '../../../ui/components/Badges.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../../ui/components/List.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import { commit } from '../Sync/connect.ts'
import { useAction, useDestinations } from '../Sync/hooks.tsx'
import { buildRemote, type DestRecord, keyringFor, saveRecord } from '../Sync/registry.ts'
import styles from '../Sync/settings.module.css'

const MIN_LENGTH = 10

export default function SealSettings() {
  const t = useT()
  const { rt, engine, records, reload } = useDestinations()
  const { busy, error, run } = useAction()
  const [chosen, setChosen] = useState('')
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [report, setReport] = useState<(SealReport & { label: string }) | null>(null)

  const all = records ?? []
  const sealable = all.filter((r): r is Extract<DestRecord, { kind: 's3' }> => r.kind === 's3' && !r.sealed)
  const source = sealable.find((r) => r.id === chosen) ?? sealable[0]
  const mismatch = again !== '' && again !== pass
  const tooShort = pass !== '' && pass.length < MIN_LENGTH

  const seal = () =>
    run('seal', async () => {
      if (!source || !engine) return
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
      // Nothing new goes to the plaintext root any more; what is already there stays until the user deletes it.
      if (engine.destIds().includes(source.id)) engine.setPaused(source.id, true)
      await saveRecord(rt, { ...source, paused: true })
      setPass('')
      setAgain('')
      reload()
    })

  return (
    <Screen title={t('common.setSeal')} back={paths.settings}>
      <div className={styles.stack}>
        <p className={styles.prose}>{t('common.sealBody')}</p>
        {all.length > 0 && (
          <ListGroup title={t('sync.destinations')}>
            {all.map((r) => (
              <ListRow key={r.id} title={r.label} trailing={<ProtectionBadge sealed={r.sealed === true} />} />
            ))}
          </ListGroup>
        )}

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
            <h2 className={styles.sectionTitle}>{t('sync.sealTitle')}</h2>
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
            <Field
              label={t('sync.passphrase')}
              hint={t('sync.passphraseHint')}
              type="password"
              autoComplete="new-password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              error={tooShort ? t('sync.sealTooShort', { count: MIN_LENGTH }) : undefined}
            />
            <Field
              label={t('sync.sealAgain')}
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              error={mismatch ? t('sync.sealMismatch') : undefined}
            />
            <p className={styles.warn}>{t('sync.sealPlaintextStays')}</p>
            <p className={styles.note}>{t('sync.sealHowItWorks')}</p>
            <div className={styles.actions}>
              <Button
                type="submit"
                variant="primary"
                loading={busy === 'seal'}
                disabled={pass.length < MIN_LENGTH || pass !== again || busy !== null}
              >
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
      </div>
    </Screen>
  )
}
