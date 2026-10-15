import { useEffect, useRef, useState } from 'react'
import { paths } from '../../../app/routes.ts'
import type { PeerLink } from '../../../core/sync/p2p/pairing'
import { useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { Segmented } from '../../../ui/components/Segmented.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import { useAction, useDestinations } from '../Sync/hooks.tsx'
import { attach, type DestRecord, saveRecord, syncNow, vault } from '../Sync/registry.ts'
import styles from '../Sync/settings.module.css'

type Role = 'host' | 'guest'

const env = () => ({ RTCPeerConnection })

/** Secrets a destination record points to (OAuth grants), handed over with it. */
const secretNames = (r: DestRecord): string[] =>
  r.kind === 'gdrive' || r.kind === 'dropbox' || r.kind === 'onedrive' ? [r.secretName] : []

function isRecord(x: unknown): x is DestRecord {
  return typeof x === 'object' && x !== null && 'kind' in x && 'id' in x && 'label' in x
}

export default function PairSettings() {
  const t = useT()
  const { rt, engine, scheduler, records, reload } = useDestinations()
  const { busy, error, run } = useAction()
  const [role, setRole] = useState<Role>('host')
  const [code, setCode] = useState('')
  const [offer, setOffer] = useState('')
  const [answer, setAnswer] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const host = useRef<{ complete(answer: string): Promise<PeerLink> } | null>(null)
  const link = useRef<PeerLink | null>(null)

  useEffect(() => () => link.current?.close(), [])

  const reset = (r: Role) => {
    setRole(r)
    setCode('')
    setOffer('')
    setAnswer('')
    setDone(null)
    host.current = null
  }

  const start = () =>
    run('start', async () => {
      const { hostPairing, newPairingCode } = await import('../../../core/sync/p2p/pairing')
      const c = newPairingCode()
      const h = await hostPairing(env(), c)
      host.current = h
      setCode(c)
      setOffer(h.offer)
    })

  const finishHost = () =>
    run('finish', async () => {
      if (!host.current) return
      const l = await host.current.complete(answer.trim())
      link.current = l
      const list = records ?? []
      const secrets: Record<string, unknown> = {}
      for (const r of list) for (const n of secretNames(r)) secrets[n] = await vault(rt).get(n)
      l.sendBundle({ destinations: list, secrets })
      setDone(t('sync.pairSent', { count: list.length }))
    })

  const join = () =>
    run('join', async () => {
      const { joinPairing } = await import('../../../core/sync/p2p/pairing')
      const j = await joinPairing(env(), code, offer.trim())
      setAnswer(j.answer)
      const l = await j.link
      link.current = l
      const bundle = await l.receiveBundle()
      const got = bundle.destinations.filter(isRecord)
      for (const [name, value] of Object.entries(bundle.secrets))
        if (value !== undefined) await vault(rt).set(name, value)
      for (const r of got) {
        await saveRecord(rt, r)
        if (engine) await attach(rt, engine, r)
      }
      reload()
      if (engine && scheduler) await syncNow(rt, engine, scheduler)
      setDone(t('sync.pairReceived', { count: got.length }))
    })

  return (
    <Screen title={t('sync.pairDevice')} back={paths.settings}>
      <div className={styles.stack}>
        <p className={styles.prose}>{t('sync.pairBody')}</p>
        <Segmented<Role>
          label={t('sync.pairRole')}
          value={role}
          onChange={reset}
          options={[
            { value: 'host', label: t('sync.pairHost') },
            { value: 'guest', label: t('sync.pairGuest') },
          ]}
        />

        {role === 'host' ? (
          <section className={styles.card} aria-label={t('sync.pairHost')}>
            {!offer ? (
              <div className={styles.actions}>
                <Button variant="primary" onClick={start} loading={busy === 'start'}>
                  {t('sync.pairStart')}
                </Button>
              </div>
            ) : (
              <>
                <p className={styles.label}>{t('sync.pairCode')}</p>
                <p className={styles.codeWord}>{code}</p>
                <label className={styles.section}>
                  <span className={styles.label}>{t('sync.pairOffer')}</span>
                  <textarea className={styles.textarea} readOnly value={offer} onFocus={(e) => e.target.select()} />
                </label>
                <label className={styles.section}>
                  <span className={styles.label}>{t('sync.pairAnswer')}</span>
                  <textarea className={styles.textarea} value={answer} onChange={(e) => setAnswer(e.target.value)} />
                </label>
                <div className={styles.actions}>
                  <Button
                    variant="primary"
                    onClick={finishHost}
                    loading={busy === 'finish'}
                    disabled={!answer.trim() || done !== null}
                  >
                    {t('sync.pairSend')}
                  </Button>
                </div>
              </>
            )}
          </section>
        ) : (
          <section className={styles.card} aria-label={t('sync.pairGuest')}>
            <Field
              label={t('sync.pairCode')}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <label className={styles.section}>
              <span className={styles.label}>{t('sync.pairOffer')}</span>
              <textarea className={styles.textarea} value={offer} onChange={(e) => setOffer(e.target.value)} />
            </label>
            <div className={styles.actions}>
              <Button
                variant="primary"
                onClick={join}
                loading={busy === 'join'}
                disabled={!code.trim() || !offer.trim() || answer !== ''}
              >
                {t('sync.pairJoin')}
              </Button>
            </div>
            {answer && (
              <label className={styles.section}>
                <span className={styles.label}>{t('sync.pairAnswerBack')}</span>
                <textarea className={styles.textarea} readOnly value={answer} onFocus={(e) => e.target.select()} />
              </label>
            )}
          </section>
        )}

        {done && (
          <p className={styles.ok} role="status">
            {done}
          </p>
        )}
        {error && (
          <p className={styles.bad} role="alert">
            {error}
          </p>
        )}
        <p className={styles.note}>{t('sync.pairPrivacy')}</p>
      </div>
    </Screen>
  )
}
