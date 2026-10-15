import { BUILD } from '../../../app/buildInfo.ts'
import { useSync } from '../../../app/syncContext.tsx'
import { formatDate } from '../../../i18n/format.ts'
import { intlTag } from '../../../i18n/index.ts'
import { useLocale, useT } from '../../../i18n/react.tsx'
import styles from '../Sync/settings.module.css'
import { UpdateControl } from './update.tsx'

/** This build (version, commit, date, sync format) and its updates; says when synced changes wait for one. */
export function VersionSection() {
  const t = useT()
  const locale = useLocale()
  const { status } = useSync()
  const waiting = (status?.needsUpgrade ?? 0) > 0
  const reads = new Intl.ListFormat(intlTag(locale), { type: 'conjunction' }).format(BUILD.format.reads.map(String))
  return (
    <section className={styles.card} aria-labelledby="settings-version">
      <h2 id="settings-version" className={styles.sectionTitle}>
        {t('settings.versionTitle')}
      </h2>
      <p className={styles.prose} data-testid="app-version">
        {t('settings.versionBuild', {
          version: BUILD.version,
          commit: BUILD.commit,
          date: formatDate(locale, new Date(BUILD.builtAt)),
        })}
      </p>
      <p className={styles.note}>{t('settings.versionFormat', { writes: String(BUILD.format.writes), reads })}</p>
      {waiting && <p className={styles.warn}>{t('settings.updateNeeded')}</p>}
      <UpdateControl waitingChanges={waiting} />
    </section>
  )
}
