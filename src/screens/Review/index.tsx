import { X } from 'lucide-react'
import { useLocation } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { ProgressRing } from '../../ui/components/ProgressRing.tsx'
import { useStudy } from '../../ui/data/useStudy.ts'
import styles from './Review.module.css'

/** Review focus view: no navigation chrome, one task. The session itself lands in S-023. */
export default function Review() {
  const t = useT()
  const [, navigate] = useLocation()
  const { due } = useStudy()
  const leave = () => navigate(paths.today)
  return (
    <div className={styles.focus}>
      <header className={styles.bar}>
        <IconButton icon={X} label={t('common.close')} onClick={leave} />
        <h1 className={styles.title}>{t('review.title')}</h1>
        {due > 0 ? (
          <ProgressRing value={0} label={t('common.progress', { done: 0, total: due })} />
        ) : (
          <span className={styles.barSpacer} />
        )}
      </header>
      <section className={styles.stage} aria-live="polite">
        {due > 0 ? (
          <p className={styles.remaining}>{t('review.remaining', { count: due })}</p>
        ) : (
          <>
            <p className={styles.remaining}>{t('common.reviewEmpty')}</p>
            <Button variant="secondary" onClick={leave}>
              {t('common.backToday')}
            </Button>
          </>
        )}
      </section>
    </div>
  )
}
