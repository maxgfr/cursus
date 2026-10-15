import { CircleCheck, HardDrive, Smartphone, Sparkles, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { estimate, persisted, requestPersistence } from '../../core/storage/persist'
import { formatBytes, formatPercent } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './Onboarding.module.css'

interface InstallState {
  installed: boolean
  /** Safari tab on iPhone/iPad (or Mac): its storage is a separate replica from the installed app. */
  safariTab: boolean
}

function installState(): InstallState {
  const nav = navigator as Navigator & { standalone?: boolean }
  const installed = matchMedia('(display-mode: standalone)').matches || nav.standalone === true
  const ua = navigator.userAgent
  const safari = /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg|OPR)\//.test(ua)
  return { installed, safariTab: safari && !installed }
}

interface Health {
  persisted: boolean
  usage: { usage: number; quota: number } | null
}

function useStorageHealth(): [Health | null, () => Promise<void>] {
  const [health, setHealth] = useState<Health | null>(null)
  const refresh = useCallback(async () => {
    const [p, e] = await Promise.all([persisted(), estimate()])
    setHealth({ persisted: p, usage: e })
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  const ask = async () => {
    await requestPersistence()
    await refresh()
  }
  return [health, ask]
}

export default function Onboarding() {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const [, navigate] = useLocation()
  const [install] = useState(installState)
  const [health, askPersist] = useStorageHealth()
  const [asking, setAsking] = useState(false)

  const [demoState, setDemoState] = useState<'idle' | 'creating' | 'failed'>('idle')

  // The demo course and the code that makes it load only now: they never weigh on the first paint.
  const demo = () => {
    if (demoState === 'creating') return
    setDemoState('creating')
    import('./demo.ts')
      .then(({ createDemoCourse }) => createDemoCourse(rt, t, locale === 'pseudo' ? undefined : locale))
      .then(
        (id) => navigate(to.course(id)),
        (e: unknown) => {
          noteError('onboarding.demo', e)
          setDemoState('failed')
        },
      )
  }

  return (
    <Screen title={t('common.welcomeTitle')}>
      <p className={styles.lead}>{t('common.welcomeBody')}</p>

      <section className={styles.step} aria-labelledby="ob-install">
        <span className={styles.icon} aria-hidden="true">
          <Smartphone size={20} strokeWidth={1.75} />
        </span>
        <div className={styles.stepBody}>
          <h2 id="ob-install" className={styles.title}>
            {t('today.installTitle')}
          </h2>
          {install.installed ? (
            <p className={styles.ok}>
              <CircleCheck size={16} aria-hidden="true" />
              {t('today.installed')}
            </p>
          ) : (
            <p className={styles.body}>{t('today.installBody')}</p>
          )}
          {install.safariTab && (
            <div className={styles.warning} role="alert">
              <TriangleAlert size={18} aria-hidden="true" />
              <p>
                <strong>{t('today.safariTabTitle')}</strong> {t('today.safariTabBody')}
              </p>
            </div>
          )}
        </div>
      </section>

      <section className={styles.step} aria-labelledby="ob-storage">
        <span className={styles.icon} aria-hidden="true">
          <HardDrive size={20} strokeWidth={1.75} />
        </span>
        <div className={styles.stepBody}>
          <h2 id="ob-storage" className={styles.title}>
            {t('today.storageTitle')}
          </h2>
          {health === null ? (
            <p className={styles.body}>{t('common.loading')}</p>
          ) : (
            <dl className={styles.health}>
              <div>
                <dt>{t('today.storageKept')}</dt>
                <dd data-testid="storage-persisted">
                  {health.persisted ? t('today.storagePersisted') : t('today.storageBestEffort')}
                </dd>
              </div>
              <div>
                <dt>{t('today.storageUsed')}</dt>
                <dd data-testid="storage-usage">
                  {health.usage === null
                    ? t('today.storageUnknown')
                    : t('today.storageUsage', {
                        used: formatBytes(locale, health.usage.usage),
                        quota: formatBytes(locale, health.usage.quota),
                        percent: formatPercent(
                          locale,
                          health.usage.quota > 0 ? health.usage.usage / health.usage.quota : 0,
                        ),
                      })}
                </dd>
              </div>
            </dl>
          )}
          {health !== null && !health.persisted && (
            <>
              <p className={styles.body}>{t('today.storageHint')}</p>
              <div>
                <Button
                  loading={asking}
                  onClick={() => {
                    setAsking(true)
                    void askPersist().finally(() => setAsking(false))
                  }}
                >
                  {t('today.storageAsk')}
                </Button>
              </div>
            </>
          )}
        </div>
      </section>

      <section className={styles.step} aria-labelledby="ob-demo">
        <span className={styles.icon} aria-hidden="true">
          <Sparkles size={20} strokeWidth={1.75} />
        </span>
        <div className={styles.stepBody}>
          <h2 id="ob-demo" className={styles.title}>
            {t('today.demoTitle')}
          </h2>
          <p className={styles.body}>{t('today.demoBody')}</p>
          <div>
            <Button loading={demoState === 'creating'} onClick={demo}>
              {t('today.demoAction')}
            </Button>
          </div>
          {demoState === 'failed' && (
            <div className={styles.warning} role="alert">
              <TriangleAlert size={18} aria-hidden="true" />
              <p>{t('today.demoFailed')}</p>
            </div>
          )}
        </div>
      </section>

      <Link href={paths.today} className={buttonClass({ variant: 'primary', size: 'large', full: true })}>
        {t('common.start')}
      </Link>
    </Screen>
  )
}
