import { BookOpen, Plus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { flushSync } from 'react-dom'
import { useLocation } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useSync } from '../../app/syncContext.tsx'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import { formatDuration } from '../../i18n/format.ts'
import { intlTag } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { CountPill, CourseDot, SyncBadge } from '../../ui/components/Badges.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { useStudy } from '../../ui/data/useStudy.ts'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './Today.module.css'

const MINUTE = 60_000

/** The review chunk is fetched before the transition starts, so the morph lands on real content. */
const preloadReview = () => import('../Review/index.tsx')

/** Creates a course on an explicit action only (nothing is ever seeded). */
function NewCourse() {
  const t = useT()
  const ws = useWorkspace()
  const [, navigate] = useLocation()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const name = title.trim()
    if (name === '') return
    const id = ws.courses.create({ title: name })
    setOpen(false)
    setTitle('')
    navigate(to.course(id))
  }
  return (
    <>
      <Button variant="secondary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setOpen(true)}>
        {t('today.addCourse')}
      </Button>
      <Sheet open={open} title={t('today.addCourse')} onClose={() => setOpen(false)}>
        <form onSubmit={submit} className={styles.form}>
          <Field
            label={t('course.name')}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            enterKeyHint="done"
            autoComplete="off"
            required
          />
          <Button type="submit" variant="primary" size="large" full disabled={title.trim() === ''}>
            {t('common.save')}
          </Button>
        </form>
      </Sheet>
    </>
  )
}

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
      trailing={<SyncBadge summary={summary} href={paths.settingsSync} />}
    >
      {study.courses.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={t('common.firstTitle')}
          body={t('common.firstBody')}
          action={<NewCourse />}
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
            {study.courses.map((c) => (
              <ListRow
                key={c.id}
                href={to.course(c.id)}
                leading={<CourseDot hue={c.hue} />}
                title={c.title}
                subtitle={t('course.cardCount', { count: c.total })}
                trailing={<CountPill count={c.due} label={t('common.dueBadge', { count: c.due })} />}
              />
            ))}
          </ListGroup>
          <div>
            <NewCourse />
          </div>
        </>
      )}
    </Screen>
  )
}
