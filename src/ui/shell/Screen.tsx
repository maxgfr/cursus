import { ChevronLeft, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'wouter'
import { isFocusRoute } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { ChatButton, isApple } from '../chat/ChatButton.tsx'
import { useChat } from '../chat/context.tsx'
import { IconButton } from '../components/IconButton.tsx'
import styles from './Screen.module.css'

export interface ScreenProps {
  title: string
  /** Shown above the title (e.g. the date) for context. */
  subtitle?: string
  trailing?: ReactNode
  /** Route of the parent screen: shows a back link. */
  back?: string
  children?: ReactNode
}

/** Opens the search palette, as ⌘K does (the palette's listener, or the one holding presses until it loads). */
function openSearch() {
  const apple = isApple()
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'k', metaKey: apple, ctrlKey: !apple, bubbles: true, cancelable: true }),
  )
}

/**
 * Standard screen: large title, optional context line and trailing control, content capped near 720px.
 * Inside the app shell a quiet bar above the title carries « Ask about this » and, on phones (no sidebar),
 * Search; the back link shares it.
 */
export function Screen({ title, subtitle, trailing, back, children }: ScreenProps) {
  const t = useT()
  const [location] = useLocation()
  // In the app's shell, outside the focus views (the welcome has nothing to ask about yet).
  const inShell = useChat() !== null && !isFocusRoute(location)
  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        {(back !== undefined || inShell) && (
          <div className={styles.bar}>
            {back !== undefined && (
              <Link href={back} className={styles.back}>
                <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
                {t('common.back')}
              </Link>
            )}
            {inShell && (
              <span className={styles.tools}>
                <IconButton
                  icon={Search}
                  label={t('common.search')}
                  className={styles.phoneOnly}
                  onClick={openSearch}
                />
                <ChatButton />
              </span>
            )}
          </div>
        )}
        {/* The trailing control sits on the title's first line; the title wraps beside it, never under it. */}
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{title}</h1>
          {trailing && <div className={styles.trailing}>{trailing}</div>}
        </div>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  )
}
