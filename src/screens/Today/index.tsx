import { BookOpen, Plus } from 'lucide-react'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useLocation } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useSync } from '../../app/syncContext.tsx'
import { formatDuration } from '../../i18n/format.ts'
import { intlTag } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { SyncBadge } from '../../ui/components/Badges.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { ListGroup } from '../../ui/components/List.tsx'
import { useStudy } from '../../ui/data/useStudy.ts'
import { Screen } from '../../ui/shell/Screen.tsx'
import { CourseRows } from './CourseRows.tsx'
import { InstallHint } from './InstallHint.tsx'
import { NewCourseSheet } from './NewCourseSheet.tsx'
import styles from './Today.module.css'

const MINUTE = 60_000

/** The review chunk is fetched before the transition starts, so the morph lands on real content. */
const preloadReview = () => import('../Review/index.tsx')

/** Navigates into the review focus view, morphing the Start surface when motion is allowed. */
function useStartReview(): () => void {
  const [, navigate] = useLocation()
  return () => {
    const go = () => navigate(paths.review)
    if (typeof document.startViewTransition !== 'function') {
      go()
      return
    }
    document.startViewTransition(async () => {
      await preloadReview()
      flushSync(go)
    })
  }
}

export default function Today() {
  const t = useT()
  const locale = useLocale()
  const study = useStudy()
  const { summary } = useSync()
  const start = useStartReview()
  const [adding, setAdding] = useState(false)
  const add = () => setAdding(true)
  const date = new Intl.DateTimeFormat(intlTag(locale), { weekday: 'long', day: 'numeric', month: 'long' }).format(
    Date.now(),
  )
  const minutes = Math.max(MINUTE, Math.ceil(study.estimateMs / MINUTE) * MINUTE)
  const meta = [t('common.approx', { duration: formatDuration(locale, minutes) })]
  if (study.newDue > 0) meta.push(t('common.newShort', { count: study.newDue }))

  return (
    <Screen
      title={t('today.title')}
      subtitle={date}
      trailing={
        <div className={styles.trailing}>
          <SyncBadge summary={summary} href={paths.settingsSync} />
          <IconButton icon={Plus} label={t('today.addCourse')} onClick={add} />
        </div>
      }
    >
      <NewCourseSheet open={adding} onClose={() => setAdding(false)} />
      <InstallHint />
      {study.courses.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={t('common.firstTitle')}
          body={t('common.firstBody')}
          action={
            <div className={styles.firstActions}>
              <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={add}>
                {t('today.addCourse')}
              </Button>
              <Link href={paths.onboarding} className={styles.setup}>
                {t('today.setupLink')}
              </Link>
            </div>
          }
        />
      ) : (
        <>
          <section className={styles.hero} aria-labelledby="today-hero">
            {study.due > 0 ? (
              <>
                <h2 id="today-hero" className={styles.label}>
                  {t('common.dueToday')}
                </h2>
                <p className={styles.count}>{t('common.cardsHero', { count: study.due })}</p>
                <p className={styles.meta}>{meta.join(' · ')}</p>
                <Button
                  className={styles.start}
                  variant="primary"
                  size="large"
                  full
                  onClick={start}
                  onPointerEnter={() => void preloadReview()}
                  onFocus={() => void preloadReview()}
                >
                  {t('common.start')}
                </Button>
              </>
            ) : (
              <>
                <h2 id="today-hero" className={styles.caughtUp}>
                  {t('common.caughtUp')}
                </h2>
                <p className={styles.meta}>
                  {study.totalCards === 0
                    ? t('common.noCardsYet')
                    : study.tomorrow > 0
                      ? t('common.tomorrow', { count: study.tomorrow })
                      : t('common.nothingTomorrow')}
                </p>
              </>
            )}
          </section>
          <ListGroup title={t('today.courses')}>
            <CourseRows courses={study.courses} />
          </ListGroup>
        </>
      )}
    </Screen>
  )
}
