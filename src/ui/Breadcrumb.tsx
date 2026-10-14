import { ChevronRight, Ellipsis } from 'lucide-react'
import { Link } from 'wouter'
import styles from './Breadcrumb.module.css'
import { cx } from './cx.ts'

export interface Crumb {
  label: string
  href: string
}

const Sep = () => <ChevronRight className={styles.sep} size={14} strokeWidth={2} aria-hidden="true" />

/**
 * Where a screen sits: the course, then each parent section, then the screen itself. On a phone only the
 * first and the nearest parents stay; the ones between fold into an ellipsis (Back still walks them).
 */
export function Breadcrumb({ label, crumbs, current }: { label: string; crumbs: readonly Crumb[]; current: string }) {
  const last = crumbs.length - 1
  return (
    <nav aria-label={label} className={styles.nav}>
      <ol className={styles.list}>
        {crumbs.map((c, i) => (
          <li key={c.href} className={cx(styles.item, i > 0 && i < last && styles.middle)}>
            {i === 1 && last > 1 && (
              <span className={styles.fold} aria-hidden="true">
                <Ellipsis size={16} strokeWidth={2} />
                <Sep />
              </span>
            )}
            <Link href={c.href} className={styles.link}>
              {c.label}
            </Link>
            <Sep />
          </li>
        ))}
        <li className={styles.item}>
          <span aria-current="page" className={styles.current}>
            {current}
          </span>
        </li>
      </ol>
    </nav>
  )
}
