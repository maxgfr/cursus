import { ChevronLeft, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { useLocation } from 'wouter'
import { type BackOptions, goBack, useNavLocation } from '../../app/nav.ts'
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
  /**
   * Route of the logical parent screen: shows a back link. It returns to the screen this one was opened from (a
   * history pop, as the browser's back does), or to this parent when opened directly.
   */
  back?: string
  /** How Back lands when it pops (e.g. on the item's own place once it moved). */
  backOptions?: BackOptions
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
export function Screen({ title, subtitle, trailing, back, backOptions, children }: ScreenProps) {
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
              <a
                href={useNavLocation.hrefs(back)}
                className={styles.back}
                onClick={(e) => {
                  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                  e.preventDefault()
                  goBack(back, backOptions)
                }}
              >
                <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
                {t('common.back')}
              </a>
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
