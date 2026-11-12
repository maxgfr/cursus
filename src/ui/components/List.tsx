import { ChevronRight, GripVertical } from 'lucide-react'
import { type ComponentProps, type ReactNode, useId } from 'react'
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
  /** Set with `onCheckedChange`: the row is a checkbox named by its title (for picking several rows). */
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  /** Props of the row's `<li>` (a sortable list's handlers, see useSortable). */
  item?: ComponentProps<'li'>
}

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  href,
  onClick,
  chevron,
  wrap,
  checked,
  onCheckedChange,
  item,
}: ListRowProps) {
  const showChevron = chevron ?? href !== undefined
  const checkId = useId()
  const body = (
    <>
      {onCheckedChange && (
        <input
          id={checkId}
          type="checkbox"
          className={styles.check}
          checked={checked ?? false}
          onChange={(e) => onCheckedChange(e.currentTarget.checked)}
        />
      )}
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
  const cls = cx(
    styles.row,
    (leading !== undefined || onCheckedChange !== undefined) && styles.withLeading,
    wrap === true && styles.wrap,
  )
  return (
    <li {...item} className={cx(styles.item, item?.className)}>
      {onCheckedChange ? (
        <label htmlFor={checkId} className={cls}>
          {body}
        </label>
      ) : href !== undefined ? (
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

/**
 * A sortable row's grip (useSortable's `handle`): pressing it lifts the row at once. Pointer only, so hidden from
 * assistive technologies: the row's move buttons do the same from the keyboard.
 */
export function ListGrip({
  label,
  onPointerDown,
}: {
  label: string
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
}) {
  return (
    <span className={styles.grip} title={label} aria-hidden="true" data-grip onPointerDown={onPointerDown}>
      <GripVertical size={20} strokeWidth={1.75} />
    </span>
  )
}
