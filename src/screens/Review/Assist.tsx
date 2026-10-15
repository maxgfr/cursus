import { Sparkles, Wand2 } from 'lucide-react'
import { useT } from '../../i18n/react.tsx'
import { useChat } from '../../ui/chat/context.tsx'
import { Button } from '../../ui/components/Button.tsx'
import styles from './Review.module.css'

const sparkle = <Sparkles size={18} strokeWidth={1.75} aria-hidden />

/**
 * « Answer in your own words »: opens the chat beside the card, where the answer is typed and graded; the grade
 * it suggests comes back to the card to confirm. Only offered once a model is ready (`ai`, the app's readiness).
 */
export function OwnWords({ ai }: { ai: boolean }) {
  const t = useT()
  const chat = useChat()
  if (!ai || !chat) return null
  return (
    <div className={styles.assist}>
      <Button variant="plain" icon={sparkle} onClick={() => chat.run('ownWords')}>
        {t('review.ownWords')}
      </Button>
    </div>
  )
}

/** Leech: a badge, the reason, a rewrite proposed in the chat (with a model ready), and Suspend. */
export function Improve({ ai, onSuspend }: { ai: boolean; onSuspend: () => void }) {
  const t = useT()
  const chat = useChat()
  return (
    <aside className={styles.leech}>
      <div className={styles.leechHead}>
        <span className={styles.leechBadge}>{t('review.leechBadge')}</span>
        <p className={styles.leechText}>{t('review.leech')}</p>
      </div>
      <div className={styles.row}>
        {/* Without a model nothing of the AI shows: the card can still be suspended. */}
        {ai && chat && (
          <Button
            variant="secondary"
            icon={<Wand2 size={18} strokeWidth={1.75} aria-hidden />}
            onClick={() => chat.run('improve')}
          >
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
