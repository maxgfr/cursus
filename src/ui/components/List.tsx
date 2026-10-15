import { ChevronRight } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { Link } from 'wouter'
import { cx } from '../cx.ts'
import styles from './List.module.css'

export interface ListGroupProps {
  title?: string
  footer?: ReactNode
  children: ReactNode
  /** Visually hide the title (it still names the list). */
  hideTitle?: boolean
}

/** Apple-style grouped inset list. */
export function ListGroup({ title, footer, hideTitle = false, children }: ListGroupProps) {
  const id = useId()
  return (
    <section className={styles.group} aria-labelledby={title ? id : undefined}>
      {title && (
        <h2 id={id} className={cx(styles.groupTitle, hideTitle && 'sr-only')}>
          {title}
        </h2>
      )}
      <ul className={styles.list}>{children}</ul>
      {footer && <p className={styles.footer}>{footer}</p>}
    </section>
  )
}

export interface ListRowProps {
  title: ReactNode
  subtitle?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  /** Hash route path: the row becomes a link. */
  href?: string
  onClick?: () => void
  chevron?: boolean
  /** The trailing controls go below the title when both do not fit side by side (long titles, wide buttons). */
  wrap?: boolean
}

export function ListRow({ title, subtitle, leading, trailing, href, onClick, chevron, wrap }: ListRowProps) {
  const showChevron = chevron ?? href !== undefined
  const body = (
    <>
      {leading && (
        <span className={styles.leading} aria-hidden="true">
          {leading}
        </span>
      )}
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
      </span>
      {(trailing || showChevron) && (
        <span className={styles.trailing}>
          {trailing}
          {showChevron && <ChevronRight className={styles.chevron} size={18} strokeWidth={2} aria-hidden="true" />}
        </span>
      )}
    </>
  )
  const cls = cx(styles.row, leading !== undefined && styles.withLeading, wrap === true && styles.wrap)
  return (
    <li className={styles.item}>
      {href !== undefined ? (
        <Link href={href} className={cls}>
          {body}
        </Link>
      ) : onClick ? (
        <button type="button" className={cls} onClick={onClick}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  )
}
