import { Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id, Rating } from '../../core/contracts/workspace'
import { intlTag } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { Keycap } from '../../ui/components/Keycap.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { useStudy } from '../../ui/data/useStudy.ts'
import { Sanitized } from '../../ui/render/Sanitized.tsx'
import { SpeakButton } from '../../ui/SpeakButton.tsx'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import { Explain, Improve, OwnWords } from './Assist.tsx'
import { describeFailure } from './failure.ts'
import styles from './Review.module.css'
import {
  type CardView,
  dropReturnsOf,
  formatInterval,
  type QueueEntry,
  RATINGS,
  readCard,
  returning,
  speakable,
  startQueue,
} from './session.ts'

const GRADE_KEY = { 1: 'review.again', 2: 'review.hard', 3: 'review.good', 4: 'review.easy' } as const
/** How long the session summary stays before settling into "All caught up". */
const SETTLE_MS = 1600
/** Grade given by Space or Enter once the answer shows. */
const DEFAULT_GRADE: Rating = 3

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
  const [start] = useState(() => startQueue(ws, Date.now()))
  const [queue, setQueue] = useState<QueueEntry[]>(() => start.queue.map((id) => ({ id })))
  const [index, setIndex] = useState(0)
  /** The queue position whose answer is showing (a card can come back later in the session). */
  const [revealedAt, setRevealedAt] = useState<number | null>(null)
  const [answered, setAnswered] = useState<Answered[]>([])
  const [suggestion, setSuggestion] = useState<(Suggestion & { at: number }) | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shownAt = useRef(Date.now())
  // Back to where the session started from (Today, a course), or Today when opened directly.
  const leave = useCallback(() => {
    if ((window.history.state as { cursusIndex?: number } | null) !== null && window.history.length > 1)
      window.history.back()
    else navigate(paths.today)
  }, [navigate])

  const currentId = queue[index]?.id
  const revealed = currentId !== undefined && revealedAt === index
  const suggested = suggestion !== null && suggestion.at === index ? suggestion : null
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

  const reveal = useCallback(() => setRevealedAt(currentId === undefined ? null : index), [currentId, index])

  const rate = useCallback(
    (rating: Rating) => {
      if (!card || !revealed) return
      const now = Date.now()
      try {
        const reviewId = ws.reviews.record({ cardId: card.id, rating, at: now, ms: now - shownAt.current })
        setAnswered((a) => [...a, { cardId: card.id, reviewId }])
        setError(null)
        setIndex((i) => i + 1)
      } catch (e) {
        console.error('review not recorded', e)
        setError(describeFailure(e, t))
      }
    },
    [card, revealed, ws, t],
  )

  const undo = useCallback(() => {
    const last = answered.at(-1)
    if (!last) return
    ws.reviews.void(last.reviewId)
    setAnswered((a) => a.slice(0, -1))
    // A return this grade caused is taken back with it.
    setQueue((q) => dropReturnsOf(q, last.reviewId))
    // The card comes back revealed, as it was when it was graded.
    setRevealedAt(Math.max(0, index - 1))
    setIndex((i) => Math.max(0, i - 1))
    setToast(t('review.undone'))
  }, [answered, ws, t, index])

  const skip = useCallback(() => {
    setQueue((q) => q.filter((e, i) => i < index || e.id !== currentId))
  }, [currentId, index])

  // One listener for the whole session, reading the state of the latest render.
  const keys = useRef({ card, revealed, reveal, rate, undo, leave })
  keys.current = { card, revealed, reveal, rate, undo, leave }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { card, revealed, reveal, rate, undo, leave } = keys.current
      if (e.defaultPrevented || document.querySelector('dialog[open]')) return
      if (e.key === 'Escape') {
        // In a text field, Esc only leaves the field.
        if (isTyping(e.target)) {
          ;(e.target as HTMLElement).blur()
          return
        }
        e.preventDefault()
        leave()
        return
      }
      if (isTyping(e.target)) return
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
      // Once the answer shows, Space and Enter give Good, unless a control has focus (it acts itself).
      if ((e.key === ' ' || e.key === 'Enter') && revealed && card) {
        if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) return
        e.preventDefault()
        rate(DEFAULT_GRADE)
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
  const finished = index >= total

  // Cards that come back today (graded Again, on a learning step) rejoin the session when due;
  // until then the session waits for them rather than claiming everything is done.
  const [now, setNow] = useState(Date.now)
  const pending = finished ? returning(ws, [...start.learning, ...answered.map((a) => a.cardId)], now) : []
  const dueNow = pending.filter((p) => p.due <= now)
  const nextAt = pending[0]?.due ?? null
  useEffect(() => {
    if (dueNow.length === 0) return
    const cause = (id: Id) => answered.findLast((a) => a.cardId === id)?.reviewId ?? null
    setQueue((q) => [...q, ...dueNow.map((p) => ({ id: p.id, returnOf: cause(p.id) }))])
  })
  // A card that came back is shown only while it is still due at its turn (an undo or another device may
  // have changed that since it was appended).
  const entry = queue[index]
  useEffect(() => {
    if (entry?.returnOf === undefined) return
    const at = Date.now()
    if (returning(ws, [entry.id], at).some((p) => p.due <= at)) return
    setQueue((q) => q.filter((e) => e !== entry))
  }, [entry, ws])
  useEffect(() => {
    if (nextAt === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [nextAt])

  return (
    <div className={styles.focus}>
      <header className={styles.bar}>
        <IconButton icon={X} label={t('common.close')} onClick={leave} />
        <h1 className={styles.title}>{t('review.title')}</h1>
        <span className={styles.barSpacer} />
      </header>
      {card && !finished ? (
        <CardStage
          card={card}
          revealed={revealed}
          onReveal={reveal}
          onRate={rate}
          suggested={suggested}
          onSuggest={(rating, feedback) => {
            setSuggestion({ at: index, rating, feedback })
            setRevealedAt(index)
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
        <Finished
          reviewed={new Set(answered.map((a) => a.cardId)).size}
          tomorrow={study.tomorrow}
          empty={answered.length === 0}
          waiting={dueNow.length === 0 && nextAt !== null ? { count: pending.length, nextAt, now } : null}
          onLeave={leave}
        />
      )}
      <footer className={styles.foot}>
        {answered.length > 0 && (
          <Button variant="plain" icon={<Undo2 size={18} strokeWidth={1.75} aria-hidden />} onClick={undo}>
            {t('review.undo')}
          </Button>
        )}
        {card && !finished && <p className={styles.keys}>{t('review.keysHint')}</p>}
      </footer>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
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
  const hintId = useId()
  const now = Date.now()
  const tag = intlTag(locale)

  // After the reveal, focus lands on the grades group (its question is announced), not on a grade:
  // nothing is preselected, and Space or Enter gives Good.
  useEffect(() => {
    if (!revealed) return
    gradesRef.current?.focus({ preventScroll: true })
  }, [revealed])

  return (
    <div className={styles.main}>
      {/* The session's one progress readout, announced politely as it changes. */}
      <p className={styles.remaining} role="status" data-testid="remaining">
        {t('review.remaining', { count: remaining })}
      </p>
      {card.leech && <Improve card={card} ai={ai} onSuspend={onSuspend} onToast={onToast} />}
      <section className={styles.stage} aria-label={card.courseTitle || t('review.title')}>
        {/* No eyebrow: the question text and the pressed answer surface carry the distinction. */}
        <section className={styles.face} aria-label={t('review.question')} data-testid="question">
          <div className={styles.faceText}>
            <Sanitized markdown={card.front} />
          </div>
          <SpeakButton text={speakable(card.front)} lang={card.language} label={t('review.readQuestion')} />
        </section>
        {revealed ? (
          <section className={styles.back} aria-label={t('review.answer')} data-testid="answer">
            {/* Centred in the footprint it shares with the hidden answer. */}
            <div className={styles.backRow}>
              <div className={styles.faceText}>
                <Sanitized markdown={card.back} />
              </div>
              <SpeakButton text={speakable(card.back)} lang={card.language} label={t('review.readAnswer')} />
            </div>
          </section>
        ) : (
          <button type="button" className={styles.reveal} onClick={onReveal} aria-keyshortcuts="Space">
            <span className={styles.revealLabel}>{t('review.showAnswer')}</span>
            <Keycap inline={false}>{t('review.revealHint')}</Keycap>
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
          <fieldset
            ref={gradesRef}
            className={styles.grades}
            tabIndex={-1}
            aria-describedby={hintId}
            data-testid="grades"
          >
            <legend className="sr-only">{t('review.gradesLabel')}</legend>
            <p id={hintId} className="sr-only">
              {t('review.gradesHint')}
            </p>
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
                  <span className={styles.gradeName}>
                    {grade}
                    <Keycap>{r}</Keycap>
                  </span>
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
  waiting,
  onLeave,
}: {
  reviewed: number
  tomorrow: number
  empty: boolean
  /** Cards coming back later today, and when the first one is due. */
  waiting: { count: number; nextAt: number; now: number } | null
  onLeave: () => void
}) {
  const t = useT()
  const locale = useLocale()
  if (waiting !== null) {
    const left = Math.max(0, waiting.nextAt - waiting.now)
    return (
      <div className={styles.main}>
        <section className={styles.stage}>
          <div className={styles.summary} data-testid="waiting">
            <h2 className={styles.summaryTitle}>
              {t('review.waitingTitle', { count: waiting.count, interval: formatInterval(left, intlTag(locale)) })}
            </h2>
            {reviewed > 0 && <p className={styles.summaryBody}>{t('review.reviewed', { count: reviewed })}</p>}
            <p className={styles.summaryBody}>
              <span aria-hidden="true">{t('review.waitingCountdown', { time: countdown(left) })}</span>
            </p>
            <p className={styles.summaryBody}>{t('review.waitingBody')}</p>
          </div>
          <Button variant="secondary" onClick={onLeave}>
            {t('common.backToday')}
          </Button>
        </section>
      </div>
    )
  }
  return <Done reviewed={reviewed} tomorrow={tomorrow} empty={empty} onLeave={onLeave} />
}

/** "4:05": minutes and seconds until a card comes back. */
function countdown(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Done({
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
