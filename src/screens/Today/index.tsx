import { BookOpen, ChartColumn, ListChecks, Play, Plus } from 'lucide-react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useLocation } from 'wouter'
import { noteLoadFailure } from '../../app/chunkGuard.ts'
import { ChunkFailed, lazyChunk, nothing } from '../../app/lazyChunk.tsx'
import { onboarded } from '../../app/onboarding.ts'
import { paths, to } from '../../app/routes.ts'
import { useSync } from '../../app/syncContext.tsx'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import { formatDuration } from '../../i18n/format.ts'
import { intlTag } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { SyncBadge } from '../../ui/components/Badges.tsx'
import { Banner } from '../../ui/components/Banner.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { Keycap } from '../../ui/components/Keycap.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { useStudy } from '../../ui/data/useStudy.ts'
import { Screen } from '../../ui/shell/Screen.tsx'
import { newCardId } from '../CardEditor/draft.ts'
import { formatInterval } from '../Review/interval.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { CourseRows } from './CourseRows.tsx'
import { InstallHint } from './InstallHint.tsx'
import { LeadLine } from './LeadLine.tsx'
import styles from './Today.module.css'

// Not on Today's first paint: the sheet's chunk loads right after it.
// Should a chunk fail: the course lead stays, and the sheet says so calmly when opened.
const ExamLead = lazyChunk(
  'today.examLead',
  () => import('./ExamLead.tsx'),
  ({ course }) => <LeadLine lead={course} />,
)
const NewCourseSheet = lazyChunk<Parameters<typeof import('./NewCourseSheet.tsx').NewCourseSheet>[0]>(
  'today.newCourse',
  () => import('./NewCourseSheet.tsx').then((m) => ({ default: m.NewCourseSheet })),
  ({ open, retry, again }) => (open ? <ChunkFailed retry={retry} again={again} /> : null),
)

// Off the first paint: the next planned session's line arrives right after it (and simply stays away should it fail).
const SessionLine = lazyChunk<object>(
  'today.sessionLine',
  () => import('./SessionLine.tsx').then((m) => ({ default: m.SessionLine })),
  nothing,
)

// Off the first paint too: the proposed questions' line (it never loads the AI code).
const DraftsLine = lazyChunk<object>(
  'today.draftsLine',
  () => import('./DraftsLine.tsx').then((m) => ({ default: m.DraftsLine })),
  nothing,
)

const MINUTE = 60_000

/** The review chunk is fetched before the transition starts, so the morph lands on real content. */
const preloadReview = () =>
  import('../Review/index.tsx').then(
    () => undefined,
    // Recorded unless a navigation aborted it; the review route itself then shows its calm retry.
    (e: unknown) => void noteLoadFailure('chunk.review.preload', e, noteError),
  )

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

/** S, or Enter with nothing focused, starts the review from Today. */
function useStartKey(enabled: boolean, start: () => void): void {
  const ref = useRef(start)
  ref.current = start
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return
      const target = e.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      )
        return
      const idle = target === document.body || target === document.documentElement
      if (e.key.toLowerCase() === 's' || (e.key === 'Enter' && idle)) {
        e.preventDefault()
        ref.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

export default function Today() {
  const t = useT()
  const locale = useLocale()
  const study = useStudy()
  const { summary, status } = useSync()
  const start = useStartReview()
  // Synced review events this version cannot read: kept in the library, left out of the schedule, said here.
  const unreadable = useWorkspaceData(['reviews'], (ws) => ws.reviews.quarantined().length)
  const [adding, setAdding] = useState(false)
  const add = () => setAdding(true)
  const [, navigate] = useLocation()
  // A first launch on an empty library opens the welcome, once per device.
  const firstLaunch = study.courses.length === 0 && !onboarded()
  useEffect(() => {
    if (firstLaunch) navigate(paths.onboarding, { replace: true })
  }, [firstLaunch, navigate])
  useStartKey(study.due > 0 && !adding, start)
  const now = Date.now()
  const date = new Intl.DateTimeFormat(intlTag(locale), { weekday: 'long', day: 'numeric', month: 'long' }).format(now)
  const minutes = Math.max(MINUTE, Math.ceil(study.estimateMs / MINUTE) * MINUTE)
  const meta = [t('common.approx', { duration: formatDuration(locale, minutes) })]
  if (study.newDue > 0) meta.push(t('common.newShort', { count: study.newDue }))
  const hasData = study.totalCards > 0
  // A destination exists (the install question is settled by the backup) and has confirmed a copy.
  const hasDestination = status !== null && status.dests.length > 0
  const backedUp = status !== null && (status.protectedOn > 0 || status.dests.some((d) => d.lastOkAt !== undefined))
  const install = <InstallHint hasDestination={hasDestination} />

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
      <Suspense fallback={null}>
        <NewCourseSheet open={adding} onClose={() => setAdding(false)} />
      </Suspense>
      {unreadable > 0 && (
        <Banner
          title={t('today.unreadableReviewsTitle')}
          body={t('today.unreadableReviews', { count: unreadable })}
          action={
            <Link href={paths.settingsDiagnostic} className={styles.setup}>
              {t('today.unreadableReviewsDetails')}
            </Link>
          }
        />
      )}
      {!hasData && install}
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
                <h2 id="today-hero" className={styles.count}>
                  {t('today.heroDue', { count: study.due })}
                </h2>
                {/* The course lead paints at once; a chapter exam's (computed off the first paint) may replace it. */}
                <Suspense fallback={<LeadLine lead={study.exam} />}>
                  <ExamLead course={study.exam} />
                </Suspense>
                <p className={styles.meta}>{meta.join(' · ')}</p>
                <Button
                  className={styles.start}
                  variant="primary"
                  size="large"
                  full
                  onClick={start}
                  onPointerEnter={() => void preloadReview()}
                  onFocus={() => void preloadReview()}
                  aria-keyshortcuts="S"
                >
                  {t('common.start')}
                  <Keycap>{t('today.startKey')}</Keycap>
                </Button>
              </>
            ) : study.totalCards === 0 ? (
              <>
                <h2 id="today-hero" className={styles.caughtUp}>
                  {t('today.firstCardTitle')}
                </h2>
                <p className={styles.meta}>{t('today.firstCardBody')}</p>
                {/* Straight to the editor, in the course: no detour through it. */}
                {study.courses[0] && (
                  <Link href={to.card(newCardId(study.courses[0].id))} className={buttonClass({ variant: 'primary' })}>
                    {t('today.firstCardAction')}
                  </Link>
                )}
              </>
            ) : study.later !== null ? (
              <>
                <h2 id="today-hero" className={styles.caughtUp}>
                  {t('today.laterTitle', {
                    count: study.later.count,
                    interval: formatInterval(Math.max(0, study.later.nextAt - now), intlTag(locale)),
                  })}
                </h2>
                <p className={styles.meta}>{t('today.laterBody')}</p>
              </>
            ) : (
              <>
                <h2 id="today-hero" className={styles.caughtUp}>
                  {t('today.caughtUp')}
                </h2>
                <p className={styles.meta}>
                  {study.tomorrow > 0 ? t('common.tomorrow', { count: study.tomorrow }) : t('common.nothingTomorrow')}
                </p>
              </>
            )}
            {hasData && (
              <Link href={paths.sessionNew} className={`${buttonClass({ variant: 'plain' })} ${styles.newSession}`}>
                {t('review.newSession')}
              </Link>
            )}
          </section>
          <Suspense fallback={null}>
            <SessionLine />
          </Suspense>
          <Suspense fallback={null}>
            <DraftsLine />
          </Suspense>
          {hasData && status !== null && !backedUp && (
            <p className={styles.backup} data-testid="backup-line">
              {t('today.backupLine')} ·{' '}
              <Link href={paths.settingsSync} className={styles.backupLink}>
                {t('today.backupAction')}
              </Link>
            </p>
          )}
          {hasData && install}
          <ListGroup title={t('today.courses')}>
            <CourseRows courses={study.courses} />
          </ListGroup>
          {hasData && (
            <ListGroup title={t('today.practice')}>
              <ListRow href={paths.sessions} leading={<Play size={20} />} title={t('review.sessions')} />
              <ListRow href={paths.quiz} leading={<ListChecks size={20} />} title={t('ai.quiz')} />
              <ListRow href={paths.stats} leading={<ChartColumn size={20} />} title={t('common.cmdStats')} />
            </ListGroup>
          )}
        </>
      )}
    </Screen>
  )
}
