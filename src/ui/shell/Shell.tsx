import { BookOpen, CalendarCheck, CalendarClock, type LucideIcon, MessageCircle, Search, Settings } from 'lucide-react'
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { useAiReady } from '../ai/ready.ts'
import { clampWidth, currentBounds, useChatWidth } from '../chat/chatWidth.ts'
import { useChat } from '../chat/context.tsx'
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
  label: 'common.today' | 'common.navCourses' | 'common.navPractice' | 'common.settings'
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
  // Practice: sessions (past, planned, new), quiz, statistics and the course tools reached from there.
  {
    href: paths.sessions,
    label: 'common.navPractice',
    icon: CalendarClock,
    match: (l) => l.startsWith(paths.sessions) || l === paths.quiz || l === paths.stats || l === paths.understand,
  },
  { href: paths.settings, label: 'common.settings', icon: Settings, match: (l) => l.startsWith(paths.settings) },
]

export interface ShellProps {
  children: ReactNode
  /** Review focus and onboarding hide the navigation chrome. */
  focus: boolean
  courses: readonly ShellCourse[]
  /** The chat panel: docked beside the page from 1000px while open, a sheet below. */
  aside?: ReactNode
}

/** Mac and iPad keyboards show ⌘; everything else Ctrl. */
function isApple(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

/** The chat width chosen on this device, kept inside the window as it is resized; null for the default. */
function useFittedChatWidth(): number | null {
  const chosen = useChatWidth()
  const [fitted, setFitted] = useState<number | null>(null)
  useEffect(() => {
    const fit = () => setFitted(chosen === null ? null : clampWidth(chosen, currentBounds()))
    fit()
    addEventListener('resize', fit)
    return () => removeEventListener('resize', fit)
  }, [chosen])
  return fitted
}

/** Phone and iPad portrait: content + bottom tab bar. iPad landscape and Mac: sidebar + content. */
export function Shell({ children, focus, courses, aside }: ShellProps) {
  const t = useT()
  const [location] = useLocation()
  useKeyboardInset()
  // Only the most specific row is the page: on a course, its sidebar row wins over the Courses tab.
  const courseRowCurrent = courses.some((c) => to.course(c.id) === location)
  const chat = useChat()
  const aiReady = useAiReady()
  const chatPx = useFittedChatWidth()
  return (
    <div
      className={cx(styles.shell, focus && styles.focus, chat?.open && styles.withChat)}
      style={chatPx === null ? undefined : ({ '--chat-width': `${chatPx}px` } as CSSProperties)}
    >
      <a className={styles.skip} href="#main">
        {t('common.skipToContent')}
      </a>
      {!focus && (
        <nav className={styles.nav} data-tabbar="" aria-label={t('common.navMain')}>
          <p className={styles.brand}>{t('common.appName')}</p>
          <ul className={styles.tabs}>
            {TABS.map((tab) => {
              const Icon = tab.icon
              const active = tab.match(location)
              // A course row being the page leaves the Courses tab as the current section, not the page.
              const current = !active ? undefined : courseRowCurrent && tab.href === paths.courses ? 'true' : 'page'
              return (
                <li key={tab.href}>
                  <Link href={tab.href} className={styles.tab} aria-current={current}>
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
          <div className={styles.footer}>
            <Link
              href={paths.search}
              className={styles.search}
              aria-current={location === paths.search ? 'page' : undefined}
              aria-keyshortcuts={isApple() ? 'Meta+K' : 'Control+K'}
            >
              <Search className={styles.tabIcon} size={18} strokeWidth={1.75} aria-hidden="true" />
              <span className={styles.searchLabel}>{t('common.search')}</span>
              <span className={styles.kbd} aria-hidden="true">
                <kbd>{isApple() ? '⌘K' : 'Ctrl K'}</kbd>
              </span>
            </Link>
            {chat && aiReady && (
              <button
                type="button"
                className={styles.search}
                aria-pressed={chat.open}
                aria-keyshortcuts={isApple() ? 'Meta+J' : 'Control+J'}
                onClick={chat.toggle}
              >
                <MessageCircle className={styles.tabIcon} size={18} strokeWidth={1.75} aria-hidden="true" />
                <span className={styles.searchLabel}>{t('chat.open')}</span>
                <span className={styles.kbd} aria-hidden="true">
                  <kbd>{isApple() ? '⌘J' : 'Ctrl J'}</kbd>
                </span>
              </button>
            )}
          </div>
        </nav>
      )}
      <main id="main" className={styles.main} tabIndex={-1}>
        {children}
      </main>
      {aside}
    </div>
  )
}
