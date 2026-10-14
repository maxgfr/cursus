import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'wouter'
import { useT } from '../../i18n/react.tsx'
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

/** Standard screen: large title, optional context line and trailing control, content capped near 720px. */
export function Screen({ title, subtitle, trailing, back, children }: ScreenProps) {
  const t = useT()
  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.titles}>
          {back !== undefined && (
            <Link href={back} className={styles.back}>
              <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
              {t('common.back')}
            </Link>
          )}
          <h1 className={styles.title}>{title}</h1>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {trailing && <div className={styles.trailing}>{trailing}</div>}
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  )
}
