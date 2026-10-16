import { Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useSearch } from 'wouter'
import { goBack } from '../../app/nav.ts'
import { paths, sessionFrom, to } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id, NewReview, Rating } from '../../core/contracts/workspace'
import { relaunchFailed, sessionQueue, sessionReview } from '../../core/model/sessions'
import { becameLeech } from '../../core/srs/leech'
import { intlTag } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { useAiReady } from '../../ui/ai/ready.ts'
import { ChatButton } from '../../ui/chat/ChatButton.tsx'
import { useChat, useChatContext } from '../../ui/chat/context.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { Keycap } from '../../ui/components/Keycap.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { useStudy } from '../../ui/data/useStudy.ts'
import { Sanitized } from '../../ui/render/Sanitized.tsx'
import { SpeakButton } from '../../ui/SpeakButton.tsx'
import { useBlobResolver } from '../Photos/files.ts'
import { useScopeOnce } from '../Section/scope.ts'
import { sessionLabel } from '../Sessions/describe.ts'
import { PracticeChip } from '../Sessions/PracticeChip.tsx'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import { Improve } from './Assist.tsx'
import { Assists } from './Assists.tsx'
import { describeFailure } from './failure.ts'
import { ImproveSheet, type Rewritten } from './ImproveSheet.tsx'
import styles from './Review.module.css'
import { replaceFaces } from './replaceFaces.ts'
import { SessionDone } from './SessionDone.tsx'
import {
  type CardView,
  dropReturnsOf,
  formatInterval,
  type QueueEntry,
  RATINGS,
  readCard,
  returning,
  schedulerFor,
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
  /** The grade made the card a leech, and the settings suspended it with the grade. */
  suspended?: true
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/**
 * Review focus view: one card at a time, nothing else on screen. Opened for a custom session (`?session=…`), it
 * runs that session's queue; relaunching its missed cards starts a fresh run.
 */
export default function Review() {
  const asked = sessionFrom(useSearch())
  const [run, setRun] = useState(asked)
  if (asked !== null && asked !== run) setRun(asked)
  return <ReviewRun key={run ?? ''} sessionId={run} />
}

function ReviewRun({ sessionId }: { sessionId: Id | null }) {
  const t = useT()
  const ws = useWorkspace()
  const [, navigate] = useLocation()
  const study = useStudy()
  const scope = useScopeOnce()
  const [session] = useState(() => (sessionId === null ? undefined : ws.sessions.get(sessionId)))
  const [start] = useState(() => {
    const now = Date.now()
    if (session === undefined) return startQueue(ws, now, scope ?? undefined)
    const { scope: where, kind, limit, practice, cardIds } = session
    const queue = sessionQueue(ws, {
      scope: where,
      kind,
      now,
      practice,
      ...(limit ? { limit } : {}),
      ...(cardIds ? { cardIds } : {}),
    })
    return { queue: queue.map((e) => e.cardId), learning: [] }
  })
  const [queue, setQueue] = useState<QueueEntry[]>(() => start.queue.map((id) => ({ id })))
  const [index, setIndex] = useState(0)
  /** The queue position whose answer is showing (a card can come back later in the session). */
  const [revealedAt, setRevealedAt] = useState<number | null>(null)
  const [answered, setAnswered] = useState<Answered[]>([])
  const [suggestion, setSuggestion] = useState<(Suggestion & { at: number }) | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // A card suspended as a leech with its grade: said, with the way back.
  const [suspended, setSuspended] = useState<Id | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shownAt = useRef(Date.now())
  // Back to where the review started from (Today, a course, a section, Practice, a planned session), popping the
  // review's entry; Today when opened directly.
  const leave = useCallback(() => {
    if (session !== undefined) ws.sessions.end(session.id)
    goBack(paths.today)
  }, [session, ws])

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
        const given: NewReview = { cardId: card.id, rating, at: now, ms: now - shownAt.current }
        const settings = ws.reviewSettings.forCourse(card.courseId)
        let leech = false
        // In a session, the review carries it, and stays out of the schedule when the session is cramming. A card
        // the grade makes a leech is suspended with it when the settings say so: one write, one undo for both.
        const reviewId = ws.batch(() => {
          const id = ws.reviews.record(session === undefined ? given : sessionReview(session, given))
          if (settings.leechAction === 'suspend') {
            const after = schedulerFor(ws, card.courseId).replay(card.id, ws.reviews.forCard(card.id))
            leech = becameLeech(card.state, after, settings.leechThreshold)
            if (leech) ws.cards.update(card.id, { suspended: true })
          }
          return id
        })
        setAnswered((a) => [...a, { cardId: card.id, reviewId, ...(leech ? { suspended: true as const } : {}) }])
        setSuspended(leech ? card.id : null)
        setError(null)
        setIndex((i) => i + 1)
      } catch (e) {
        console.error('review not recorded', e)
        setError(describeFailure(e, t))
      }
    },
    [card, revealed, ws, t, session],
  )

  const undo = useCallback(() => {
    const last = answered.at(-1)
    if (!last) return
    ws.batch(() => {
      ws.reviews.void(last.reviewId)
      // A card suspended with the grade comes back with it.
      if (last.suspended) ws.cards.update(last.cardId, { suspended: undefined })
    })
    setSuspended(null)
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

  // One listener for the whole session, reading the state of the latest render. In place as the first card
  // paints (a layout effect, not one run after the paint): a key pressed as soon as the card shows is never lost.
  const keys = useRef({ card, revealed, reveal, rate, undo, leave })
  keys.current = { card, revealed, reveal, rate, undo, leave }
  useLayoutEffect(() => {
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
  useChatContext(
    card && !finished
      ? { courseId: card.courseId, card: { front: card.front, back: card.back, revealed, id: card.id } }
      : session?.scope.courseId
        ? { courseId: session.scope.courseId }
        : {},
  )

  // A grade suggested in the chat for this card (answered there in the student's own words): the answer shows, the
  // grade is offered, the student confirms it.
  const graded = useChat()?.graded
  const seenGrade = useRef(graded?.seq ?? 0)
  useEffect(() => {
    if (!graded || graded.seq === seenGrade.current) return
    seenGrade.current = graded.seq
    if (!card || graded.card.front !== card.front || graded.card.back !== card.back) return
    setSuggestion({ at: index, rating: graded.rating, feedback: graded.feedback })
    setRevealedAt(index)
  }, [graded, card, index])

  // A grade given in the chat to this card (confirming the suggested one, or another): recorded as on the card.
  const rated = useChat()?.rated
  const seenRating = useRef(rated?.seq ?? 0)
  useEffect(() => {
    if (!rated || rated.seq === seenRating.current) return
    seenRating.current = rated.seq
    if (!card || rated.card.front !== card.front || rated.card.back !== card.back) return
    rate(rated.rating)
  }, [rated, card, rate])

  // Cards that come back today (graded Again, on a learning step) rejoin the session when due;
  // until then the session waits for them rather than claiming everything is done.
  const [now, setNow] = useState(Date.now)
  // A custom session is its queue, fixed when it starts: what it sends back (on a learning step) waits for Today.
  const pending =
    finished && session === undefined ? returning(ws, [...start.learning, ...answered.map((a) => a.cardId)], now) : []
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
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>{session === undefined ? t('review.title') : sessionLabel(ws, t, session)}</h1>
          {session?.practice === true && <PracticeChip />}
        </div>
        <ChatButton className={styles.end} />
      </header>
      {card && !finished ? (
        <CardStage
          card={card}
          revealed={revealed}
          onReveal={reveal}
          onRate={rate}
          suggested={suggested}
          onGraded={(rating, feedback) => {
            setSuggestion({ at: index, rating, feedback })
            setRevealedAt(index)
          }}
          onSuspend={() => {
            ws.cards.update(card.id, { suspended: true })
            setToast(t('review.suspended'))
            skip()
          }}
          remaining={total - done}
        />
      ) : session !== undefined ? (
        <SessionDone
          session={session}
          onLeave={leave}
          onRelaunch={() => {
            const id = relaunchFailed(ws, session.id)
            if (id !== null) navigate(to.sessionRun(id), { replace: true, state: { session: id } })
          }}
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
      {toast === null && suspended !== null && (
        <Toast
          message={t('review.leechSuspended')}
          actions={[
            { label: t('common.undo'), onClick: undo },
            { label: t('review.dismiss'), onClick: () => setSuspended(null) },
          ]}
        />
      )}
    </div>
  )
}

interface CardStageProps {
  card: CardView
  revealed: boolean
  onReveal: () => void
  onRate: (r: Rating) => void
  suggested: Suggestion | null
  /** A grade suggested for an answer typed in one's own words: the answer shows, the grade is offered. */
  onGraded: (rating: Rating, feedback: string) => void
  onSuspend: () => void
  remaining: number
}

function CardStage({ card, revealed, onReveal, onRate, suggested, onGraded, onSuspend, remaining }: CardStageProps) {
  const t = useT()
  const ws = useWorkspace()
  const [improving, setImproving] = useState(false)
  const [rewritten, setRewritten] = useState<Rewritten | null>(null)
  const locale = useLocale()
  // Shown on the app's one readiness (as the chat button); the model's details only say whether it runs offline.
  const aiReady = useAiReady()
  const ai = useAiModel()
  const gradesRef = useRef<HTMLFieldSetElement>(null)
  const hintId = useId()
  const now = Date.now()
  const tag = intlTag(locale)
  // Card photos (`cursus-blob:`), fetched from a destination when kept on demand.
  const resolveBlob = useBlobResolver(`${card.shown.front}\n${card.shown.back}`)

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
      {card.leech && <Improve ai={aiReady} onImprove={() => setImproving(true)} onSuspend={onSuspend} />}
      <ImproveSheet
        cardId={improving ? card.id : null}
        revealed={revealed}
        onClose={() => setImproving(false)}
        onUsed={setRewritten}
      />
      {rewritten && (
        <Toast
          message={t('review.improved')}
          actions={[
            {
              label: t('common.undo'),
              onClick: () => {
                replaceFaces(ws, rewritten.cardId, rewritten.front, rewritten.back)
                setRewritten(null)
              },
            },
            { label: t('common.dismiss'), onClick: () => setRewritten(null) },
          ]}
        />
      )}
      <section className={styles.stage} aria-label={card.courseTitle || t('review.title')}>
        {/* No eyebrow: the question text and the pressed answer surface carry the distinction. */}
        <section className={styles.face} aria-label={t('review.question')} data-testid="question">
          <div className={styles.faceText}>
            <Sanitized markdown={card.shown.front} resolveBlob={resolveBlob} />
          </div>
          <SpeakButton text={speakable(card.front)} lang={card.language} label={t('review.readQuestion')} />
        </section>
        {revealed ? (
          <section className={styles.back} aria-label={t('review.answer')} data-testid="answer">
            {/* Centred in the footprint it shares with the hidden answer. */}
            <div className={styles.backRow}>
              <div className={styles.faceText}>
                <Sanitized markdown={card.shown.back} resolveBlob={resolveBlob} />
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
        </>
      )}
      {aiReady && <Assists key={`assists-${card.id}`} card={card} revealed={revealed} ai={ai} onGraded={onGraded} />}
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
