import { CircleCheck, HardDrive, Smartphone, Sparkles, TriangleAlert, Wand2 } from 'lucide-react'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { ChunkFailed, lazyChunk } from '../../app/lazyChunk.tsx'
import { canGoBack } from '../../app/nav.ts'
import { markOnboarded } from '../../app/onboarding.ts'
import { paths, to } from '../../app/routes.ts'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { estimate, persisted, requestPersistence } from '../../core/storage/persist'
import { formatBytes, formatPercent } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './Onboarding.module.css'

const NewCourseSheet = lazyChunk<Parameters<typeof import('../Today/NewCourseSheet.tsx').NewCourseSheet>[0]>(
  'onboarding.newCourse',
  () => import('../Today/NewCourseSheet.tsx').then((m) => ({ default: m.NewCourseSheet })),
  ({ open, retry, again }) => (open ? <ChunkFailed retry={retry} again={again} /> : null),
)

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

/**
 * The welcome a first launch opens on: how Cursus works (sources, cards, a daily review), keeping the data
 * safe, AI only if wanted, then a first course or the demo. Seen once, it never opens by itself again.
 */
export default function Onboarding() {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const [, navigate] = useLocation()
  const [install] = useState(installState)
  const [health, askPersist] = useStorageHealth()
  const [asking, setAsking] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(markOnboarded, [])

  const [demoState, setDemoState] = useState<'idle' | 'creating' | 'failed'>('idle')

  // The demo course and the code that makes it load only now: they never weigh on the first paint.
  const demo = () => {
    if (demoState === 'creating') return
    setDemoState('creating')
    import('./demo.ts')
      .then(async ({ createDemoCourse, demoTranslator }) =>
        createDemoCourse(rt, await demoTranslator(locale), locale === 'pseudo' ? undefined : locale),
      )
      .then(
        // The welcome is done: the course takes its place, so the course's Back never reopens it.
        (id) => navigate(to.course(id), { replace: true }),
        (e: unknown) => {
          noteError('onboarding.demo', e)
          setDemoState('failed')
        },
      )
  }

  return (
    // Opened from the app (Settings › Welcome): a Back returns there. On first launch it stands alone.
    <Screen title={t('common.welcomeTitle')} back={canGoBack() ? paths.settings : undefined}>
      <p className={styles.lead}>{t('common.welcomeBody')}</p>

      <section className={styles.loop} aria-labelledby="ob-loop">
        <h2 id="ob-loop" className={styles.loopTitle}>
          {t('today.obLoopTitle')}
        </h2>
        <ol className={styles.loopSteps}>
          <li>
            <strong>{t('today.obLoop1Title')}</strong>
            <span>{t('today.obLoop1Body', { add: t('sync.add') })}</span>
          </li>
          <li>
            <strong>{t('today.obLoop2Title')}</strong>
            <span>{t('today.obLoop2Body', { generate: t('ai.generate'), newCard: t('course.addCard') })}</span>
          </li>
          <li>
            <strong>{t('today.obLoop3Title')}</strong>
            <span>{t('today.obLoop3Body', { today: t('common.today'), start: t('common.start') })}</span>
          </li>
        </ol>
      </section>

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
          <p className={styles.body}>{t('today.obDataBody')}</p>
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

      <section className={styles.step} aria-labelledby="ob-ai">
        <span className={styles.icon} aria-hidden="true">
          <Wand2 size={20} strokeWidth={1.75} />
        </span>
        <div className={styles.stepBody}>
          <h2 id="ob-ai" className={styles.title}>
            {t('today.obAiTitle')}
          </h2>
          <p className={styles.body}>{t('today.obAiBody')}</p>
          <div className={styles.choices}>
            <Link href={`${paths.settingsAi}?setup=local`} className={buttonClass({ variant: 'secondary' })}>
              {t('today.obAiLocal')}
            </Link>
            <Link href={`${paths.settingsAi}?setup=key`} className={buttonClass({ variant: 'secondary' })}>
              {t('today.obAiKey')}
            </Link>
          </div>
          <p className={styles.body}>{t('today.obAiLater')}</p>
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

      <div className={styles.finish}>
        <Button variant="primary" size="large" full onClick={() => setAdding(true)}>
          {t('today.obCreate')}
        </Button>
        <Link replace href={paths.today} className={buttonClass({ variant: 'plain' })}>
          {t('today.obSkip')}
        </Link>
      </div>
      <Suspense fallback={null}>
        <NewCourseSheet open={adding} onClose={() => setAdding(false)} />
      </Suspense>
    </Screen>
  )
}
