import { Link } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { isCardRich, type RichResult, richText } from '../../core/ai/features/tutorChat'
import type { Chunk } from '../../core/ai/retrieval'
import { useT } from '../../i18n/react.tsx'
import { GENERATE_QUERY } from '../../screens/Generate/open.tsx'
import styles from './ChatPanel.module.css'
import type { ScreenContext } from './context.tsx'
import { RichAnswer } from './RichAnswer.tsx'

type Faces = { front: string; back: string }

/** Whether an answer about `faces` may show in full: always, unless that card is on screen unrevealed. */
export const revealedFor = (faces: Faces, card: ScreenContext['card']) =>
  !(card && !card.revealed && card.front === faces.front && card.back === faces.back)

/**
 * A structured answer of an earlier thread, from when the chat ran the AI features itself. An explanation shows as
 * it did, guarded until the card's reveal; anything else as its text, with a link to where that feature lives now.
 * A grade or a rewrite of the card on screen, unrevealed, waits for the reveal.
 */
export function LegacyAnswer({
  rich,
  card,
  chunks,
  courseId,
}: {
  rich: RichResult
  card: ScreenContext['card']
  chunks: readonly Chunk[]
  courseId: string | undefined
}) {
  const t = useT()
  if (isCardRich(rich)) {
    return <RichAnswer rich={rich} revealed={revealedFor(rich.card, card)} chunks={chunks} courseId={courseId} />
  }
  const hidden =
    (rich.kind === 'grade' && !revealedFor(rich.card, card)) || (rich.kind === 'improve' && card?.revealed === false)
  const link = linkOf(t, rich)
  return (
    <div className={styles.legacy}>
      {hidden ? (
        <p className={styles.note}>{t('chat.hidden')}</p>
      ) : (
        <p className={styles.legacyText}>{richText(rich)}</p>
      )}
      {link && (
        <Link href={link.href} className={styles.legacyLink}>
          {link.label}
        </Link>
      )}
    </div>
  )
}

function linkOf(t: ReturnType<typeof useT>, rich: RichResult): { href: string; label: string } | null {
  switch (rich.kind) {
    case 'cards':
      return { href: `${paths.inbox}?${GENERATE_QUERY}`, label: t('ai.deckQuestionsTitle') }
    case 'job':
      return { href: paths.inbox, label: t('chat.openSuggested') }
    case 'quiz':
      return { href: paths.quiz, label: t('ai.quiz') }
    case 'sheet':
      return rich.savedId ? { href: to.fiche(rich.savedId), label: t('chat.legacyOpenSheet') } : null
    case 'photo':
      return { href: to.photo(rich.photoId), label: t('chat.legacyOpenPhoto') }
    case 'improve':
      return { href: to.card(rich.cardId), label: t('chat.editCard') }
    default:
      return null
  }
}
