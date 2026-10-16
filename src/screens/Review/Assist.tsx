import { Wand2 } from 'lucide-react'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import styles from './Review.module.css'

/** Leech: a badge, the reason, a rewrite proposed beside it (with a model ready), and Suspend. */
export function Improve({ ai, onImprove, onSuspend }: { ai: boolean; onImprove: () => void; onSuspend: () => void }) {
  const t = useT()
  return (
    <aside className={styles.leech}>
      <div className={styles.leechHead}>
        <span className={styles.leechBadge}>{t('review.leechBadge')}</span>
        <p className={styles.leechText}>{t('review.leech')}</p>
      </div>
      <div className={styles.row}>
        {/* Without a model nothing of the AI shows: the card can still be suspended. */}
        {ai && (
          <Button variant="secondary" icon={<Wand2 size={18} strokeWidth={1.75} aria-hidden />} onClick={onImprove}>
            {t('review.improve')}
          </Button>
        )}
        <Button variant="plain" onClick={onSuspend}>
          {t('review.suspend')}
        </Button>
      </div>
    </aside>
  )
}
