import { Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id, Rating } from '../../core/contracts/workspace'
import { intlTag } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { ProgressRing } from '../../ui/components/ProgressRing.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { useStudy } from '../../ui/data/useStudy.ts'
import { Sanitized } from '../../ui/render/Sanitized.tsx'
import { SpeakButton } from '../../ui/SpeakButton.tsx'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import { Explain, Improve, OwnWords } from './Assist.tsx'
import styles from './Review.module.css'
import { type CardView, formatInterval, RATINGS, readCard, speakable, startQueue } from './session.ts'

const GRADE_KEY = { 1: 'review.again', 2: 'review.hard', 3: 'review.good', 4: 'review.easy' } as const
/** How long the session summary stays before settling into "All caught up". */
const SETTLE_MS = 1600

interface Suggestion {
  rating: Rating
  feedback: string
}

interface Answered {
  cardId: Id
  reviewId: Id
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** Review focus view: one card at a time, nothing else on screen. */
export default function Review() {
  const t = useT()
  const ws = useWorkspace()
  const [, navigate] = useLocation()
  const study = useStudy()
  const [queue, setQueue] = useState<Id[]>(() => startQueue(ws, Date.now()))
  const [index, setIndex] = useState(0)
  /** The card whose answer is showing; any other card starts hidden. */
  const [revealedId, setRevealedId] = useState<Id | null>(null)
  const [answered, setAnswered] = useState<Answered[]>([])
  const [suggestion, setSuggestion] = useState<(Suggestion & { cardId: Id }) | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const shownAt = useRef(Date.now())
  const leave = () => navigate(paths.today)

  const currentId = queue[index]
  const revealed = currentId !== undefined && revealedId === currentId
  const suggested = suggestion !== null && suggestion.cardId === currentId ? suggestion : null
  const card = useWorkspaceData(
    ['cards', 'courses', 'reviews', 'prefs', { id: currentId ?? '' }],
    (w): CardView | null => (currentId === undefined ? null : readCard(w, currentId, Date.now())),
  )

  // Answer time counts from when the card appears.
  useEffect(() => {
    if (currentId !== undefined) shownAt.current = Date.now()
  }, [currentId])

  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const reveal = useCallback(() => setRevealedId(currentId ?? null), [currentId])

  const rate = useCallback(
    (rating: Rating) => {
      if (!card || !revealed) return
      const now = Date.now()
      const reviewId = ws.reviews.record({ cardId: card.id, rating, at: now, ms: now - shownAt.current })
      setAnswered((a) => [...a, { cardId: card.id, reviewId }])
      setIndex((i) => i + 1)
    },
    [card, revealed, ws],
  )

  const undo = useCallback(() => {
    const last = answered.at(-1)
    if (!last) return
    ws.reviews.void(last.reviewId)
    setAnswered((a) => a.slice(0, -1))
    // The card comes back revealed, as it was when it was graded.
    setRevealedId(last.cardId)
    setIndex((i) => Math.max(0, i - 1))
    setToast(t('review.undone'))
  }, [answered, ws, t])

  const skip = useCallback(() => {
    setQueue((q) => q.filter((id) => id !== currentId))
  }, [currentId])

  // One listener for the whole session, reading the state of the latest render.
  const keys = useRef({ card, revealed, reveal, rate, undo })
  keys.current = { card, revealed, reveal, rate, undo }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { card, revealed, reveal, rate, undo } = keys.current
      if (e.defaultPrevented || isTyping(e.target) || document.querySelector('dialog[open]')) return
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ' && !revealed && card) {
        // A focused button handles Space itself (and the reveal button reveals).
        if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) return
        e.preventDefault()
        reveal()
        return
      }
      const n = Number(e.key)
      if (revealed && n >= 1 && n <= 4) {
        e.preventDefault()
        rate(n as Rating)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const total = queue.length
  const done = Math.min(index, total)
  const finished = total > 0 && index >= total

  return (
    <div className={styles.focus}>
      <header className={styles.bar}>
        <IconButton icon={X} label={t('common.close')} onClick={leave} />
        <h1 className={styles.title}>{t('review.title')}</h1>
        {total > 0 ? (
          <ProgressRing value={done / total} label={t('common.progress', { done, total })} />
        ) : (
          <span className={styles.barSpacer} />
        )}
      </header>
      {card && !finished ? (
        <CardStage
          card={card}
          revealed={revealed}
          onReveal={reveal}
          onRate={rate}
          suggested={suggested}
          onSuggest={(rating, feedback) => {
            setSuggestion({ cardId: card.id, rating, feedback })
            setRevealedId(card.id)
          }}
          onSuspend={() => {
            ws.cards.update(card.id, { suspended: true })
            setToast(t('review.suspended'))
            skip()
          }}
          onToast={setToast}
          remaining={total - done}
        />
      ) : (
        <Finished reviewed={answered.length} tomorrow={study.tomorrow} empty={total === 0} onLeave={leave} />
      )}
      <footer className={styles.foot}>
        {answered.length > 0 && (
          <Button variant="plain" icon={<Undo2 size={18} strokeWidth={1.75} aria-hidden />} onClick={undo}>
            {t('review.undo')}
          </Button>
        )}
        {card && !finished && <p className={styles.keys}>{t('review.keysHint')}</p>}
      </footer>
      {toast !== null && <Toast message={toast} />}
    </div>
  )
}

interface CardStageProps {
  card: CardView
  revealed: boolean
  onReveal: () => void
  onRate: (r: Rating) => void
  suggested: Suggestion | null
  onSuggest: (rating: Rating, feedback: string) => void
  onSuspend: () => void
  onToast: (message: string) => void
  remaining: number
}

function CardStage({
  card,
  revealed,
  onReveal,
  onRate,
  suggested,
  onSuggest,
  onSuspend,
  onToast,
  remaining,
}: CardStageProps) {
  const t = useT()
  const locale = useLocale()
  const ai = useAiModel()
  const gradesRef = useRef<HTMLFieldSetElement>(null)
  const now = Date.now()
  const tag = intlTag(locale)

  // After the reveal, keyboard and screen-reader users land on the grades.
  useEffect(() => {
    if (!revealed) return
    const target =
      gradesRef.current?.querySelector<HTMLButtonElement>('[data-suggested="true"]') ??
      gradesRef.current?.querySelector<HTMLButtonElement>('button')
    target?.focus({ preventScroll: true })
  }, [revealed])

  return (
    <div className={styles.main}>
      <p className={styles.remaining}>{t('review.remaining', { count: remaining })}</p>
      {card.leech && <Improve card={card} ai={ai} onSuspend={onSuspend} onToast={onToast} />}
      <section className={styles.stage} aria-label={card.courseTitle || t('review.title')}>
        <div className={styles.face}>
          <div className={styles.faceHead}>
            <h2 className={styles.label}>{t('review.question')}</h2>
            <SpeakButton text={speakable(card.front)} lang={card.language} label={t('review.readQuestion')} />
          </div>
          <Sanitized markdown={card.front} />
        </div>
        {revealed ? (
          <div className={styles.face} data-testid="answer">
            <div className={styles.faceHead}>
              <h2 className={styles.label}>{t('review.answer')}</h2>
              <SpeakButton text={speakable(card.back)} lang={card.language} label={t('review.readAnswer')} />
            </div>
            <Sanitized markdown={card.back} />
          </div>
        ) : (
          <button type="button" className={styles.reveal} onClick={onReveal}>
            <span className={styles.revealLabel}>{t('review.showAnswer')}</span>
            <span className={styles.revealHint}>{t('review.revealHint')}</span>
          </button>
        )}
      </section>
      {!revealed && <OwnWords key={card.id} card={card} ai={ai} onSuggest={onSuggest} />}
      {revealed && (
        <>
          {suggested !== null && (
            <div className={styles.panel} role="status">
              <p className={styles.suggestTitle}>{t('review.suggested', { grade: t(GRADE_KEY[suggested.rating]) })}</p>
              <p>{suggested.feedback}</p>
              <p className={styles.aside}>{t('review.confirmHint')}</p>
            </div>
          )}
          <fieldset ref={gradesRef} className={styles.grades}>
            <legend className="sr-only">{t('review.gradesLabel')}</legend>
            {RATINGS.map((r) => {
              const interval = formatInterval(Math.max(0, card.preview[r] - now), tag)
              const grade = t(GRADE_KEY[r])
              return (
                <button
                  key={r}
                  type="button"
                  className={styles.grade}
                  data-rating={r}
                  data-suggested={suggested?.rating === r}
                  aria-label={t('review.gradeLabel', { grade, interval })}
                  aria-keyshortcuts={String(r)}
                  onClick={() => onRate(r)}
                >
                  <span className={styles.gradeName}>{grade}</span>
                  <span className={styles.gradeInterval}>{interval}</span>
                  {suggested?.rating === r && <span className={styles.gradeTag}>{t('review.suggestedTag')}</span>}
                </button>
              )
            })}
          </fieldset>
          <Explain key={card.id} card={card} ai={ai} onToast={onToast} />
        </>
      )}
    </div>
  )
}

function Finished({
  reviewed,
  tomorrow,
  empty,
  onLeave,
}: {
  reviewed: number
  tomorrow: number
  empty: boolean
  onLeave: () => void
}) {
  const t = useT()
  const [settled, setSettled] = useState(empty)
  useEffect(() => {
    if (settled) return
    const timer = setTimeout(() => setSettled(true), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [settled])

  return (
    <div className={styles.main}>
      <section className={styles.stage} aria-live="polite">
        <div className={styles.summary} key={settled ? 'settled' : 'summary'} data-settled={settled}>
          {settled ? (
            <>
              <h2 className={styles.summaryTitle}>{t('review.caughtUp')}</h2>
              {reviewed > 0 && <p className={styles.summaryBody}>{t('review.reviewed', { count: reviewed })}</p>}
              <p className={styles.summaryBody}>
                {tomorrow > 0 ? t('review.tomorrow', { count: tomorrow }) : t('review.tomorrowNone')}
              </p>
            </>
          ) : (
            <>
              <h2 className={styles.summaryTitle}>{t('review.sessionDone')}</h2>
              <p className={styles.summaryBody}>{t('review.reviewed', { count: reviewed })}</p>
            </>
          )}
        </div>
        <Button variant={settled ? 'primary' : 'secondary'} onClick={onLeave}>
          {t('common.backToday')}
        </Button>
      </section>
    </div>
  )
}
