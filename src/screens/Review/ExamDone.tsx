import { useEffect } from 'react'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id, Session } from '../../core/contracts/workspace'
import { type ExamAnswer, examStruggled } from '../../core/srs/exam'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import styles from './Review.module.css'
import { readCard, speakable } from './session.ts'

/**
 * The end of an exam sitting: the whole batch is known. It is closed in the log, and the cards that took several
 * passes are listed, most passes first: those to look at again.
 */
export function ExamDone({
  session,
  batch,
  answers,
  onLeave,
}: {
  session: Session
  batch: readonly Id[]
  answers: readonly ExamAnswer[]
  onLeave: () => void
}) {
  const t = useT()
  const ws = useWorkspace()
  // Ending again does nothing: an undo and a second finish keep the first end.
  useEffect(() => ws.sessions.end(session.id), [ws, session.id])
  const struggled = useWorkspaceData(['cards', 'courses'], (w) =>
    examStruggled(batch, answers).map((s) => ({
      ...s,
      front: speakable(readCard(w, s.cardId, Date.now())?.front ?? ''),
    })),
  )

  return (
    <div className={styles.main}>
      <section className={styles.stage} aria-live="polite">
        <div className={styles.summary} data-testid="exam-done">
          <h2 className={styles.summaryTitle}>{t('review.examDone')}</h2>
          <p className={styles.summaryBody}>{t('review.examDoneBody', { count: batch.length })}</p>
          {struggled.length === 0 && <p className={styles.summaryBody}>{t('review.examNoneStruggled')}</p>}
        </div>
        <Button variant="primary" onClick={onLeave}>
          {t('common.done')}
        </Button>
      </section>
      {struggled.length > 0 && (
        <ListGroup title={t('review.examStruggled')}>
          {struggled.map((s) => (
            <ListRow key={s.cardId} title={s.front} subtitle={t('review.examPasses', { count: s.passes })} />
          ))}
        </ListGroup>
      )}
    </div>
  )
}
