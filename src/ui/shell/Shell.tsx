import { BookOpen, CalendarCheck, Lightbulb, type LucideIcon, Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { CourseDot, type CourseHue } from '../components/Badges.tsx'
import { cx } from '../cx.ts'
import styles from './Shell.module.css'
import { useKeyboardInset } from './useKeyboardInset.ts'

export interface ShellCourse {
  id: string
  title: string
  hue: CourseHue
  due: number
}

interface Tab {
  href: string
  label: 'common.today' | 'common.navCourses' | 'common.navUnderstand' | 'common.settings'
  icon: LucideIcon
  match: (loc: string) => boolean
}

const TABS: readonly Tab[] = [
  { href: paths.today, label: 'common.today', icon: CalendarCheck, match: (l) => l === paths.today },
  {
    href: paths.courses,
    label: 'common.navCourses',
    icon: BookOpen,
    match: (l) => l === paths.courses || /^\/(course|source|card|history)\//.test(l),
  },
  {
    href: paths.understand,
    label: 'common.navUnderstand',
    icon: Lightbulb,
    match: (l) => l === paths.understand || l === paths.generate || l === paths.quiz,
  },
  { href: paths.settings, label: 'common.settings', icon: Settings, match: (l) => l.startsWith(paths.settings) },
]

export interface ShellProps {
  children: ReactNode
  /** Review focus and onboarding hide the navigation chrome. */
  focus: boolean
  courses: readonly ShellCourse[]
}

/** Phone and iPad portrait: content + bottom tab bar. iPad landscape and Mac: sidebar + content. */
export function Shell({ children, focus, courses }: ShellProps) {
  const t = useT()
  const [location] = useLocation()
  useKeyboardInset()
  return (
    <div className={cx(styles.shell, focus && styles.focus)}>
      <a className={styles.skip} href="#main">
        {t('common.skipToContent')}
      </a>
      {!focus && (
        <nav className={styles.nav} data-tabbar="" aria-label={t('common.navMain')}>
          <div className={styles.brandRow}>
            <h2 className={styles.brand}>{t('common.appName')}</h2>
          </div>
          <ul className={styles.tabs}>
            {TABS.map((tab) => {
              const Icon = tab.icon
              const active = tab.match(location)
              return (
                <li key={tab.href}>
                  <Link href={tab.href} className={styles.tab} aria-current={active ? 'page' : undefined}>
                    <Icon className={styles.tabIcon} size={22} strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
                    <span>{t(tab.label)}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
          {courses.length > 0 && (
            <section className={styles.courses} aria-labelledby="sidebar-courses">
              <h3 id="sidebar-courses" className={styles.coursesTitle}>
                {t('common.navCourses')}
              </h3>
              <ul className={styles.courseList}>
                {courses.map((c) => {
                  const href = to.course(c.id)
                  return (
                    <li key={c.id}>
                      <Link
                        href={href}
                        className={styles.courseLink}
                        aria-current={location === href ? 'page' : undefined}
                      >
                        <CourseDot hue={c.hue} />
                        <span className={styles.courseName}>{c.title}</span>
                        {c.due > 0 && (
                          <span className={styles.courseDue}>
                            <span aria-hidden="true">{c.due}</span>
                            <span className="sr-only">{t('common.dueBadge', { count: c.due })}</span>
                          </span>
                        )}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </nav>
      )}
      <main id="main" className={styles.main} tabIndex={-1}>
        {children}
      </main>
    </div>
  )
}
