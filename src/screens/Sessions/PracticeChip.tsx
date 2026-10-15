import { useT } from '../../i18n/react.tsx'
import styles from './PracticeChip.module.css'

/** Marks a session kept out of the schedule: its answers never move review dates. */
export function PracticeChip() {
  const t = useT()
  return (
    <span className={styles.chip} data-testid="cramming">
      {t('review.cramming')}
    </span>
  )
}
