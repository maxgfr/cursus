import { BrainCircuit, CircleHelp, KeyRound, Lightbulb, type LucideIcon, MessageCircle, PenLine, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useRuntime } from '../../app/workspaceContext.tsx'
import type { CardRich, ChatIntent } from '../../core/ai/features/tutorChat'
import { parseCitations, richText } from '../../core/ai/features/tutorChat'
import type { Chunk } from '../../core/ai/retrieval'
import type { CardExplanation, QuestionExplanationDraft } from '../../core/ai/schemas'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Answer } from '../../ui/chat/Answer.tsx'
import { useChat } from '../../ui/chat/context.tsx'
import { PartialRich, RichAnswer } from '../../ui/chat/RichAnswer.tsx'
import { chunkLoader } from '../../ui/chat/studyRun.ts'
import { Button } from '../../ui/components/Button.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { usePartial } from '../../ui/data/usePartial.ts'
import { askAbout, keepSelection, useCanCallAi, useSelectedTerm } from '../../ui/ExplainLauncher.tsx'
import type { AiModelState } from '../Understand/shared/aiConfig.ts'
import styles from './Assists.module.css'
import { type AssistDeps, explainRun, gradeRun, guidedRun } from './assistRun.ts'
import { describeFailure } from './failure.ts'
import type { CardView } from './session.ts'

type AssistId = 'explainQuestion' | 'hint' | 'why' | 'mnemonic' | 'ownWords'

const ICONS: Record<AssistId, LucideIcon> = {
  explainQuestion: CircleHelp,
  hint: KeyRound,
  why: Lightbulb,
  mnemonic: BrainCircuit,
  ownWords: PenLine,
}

/** What a panel shows: a structured explanation, a guided answer, or a grade, as it is written then complete. */
type Result =
  | { kind: 'rich'; rich: CardRich; chunks: readonly Chunk[] }
  | { kind: 'text'; text: string; chunks: readonly Chunk[]; done: boolean }
  | { kind: 'grade'; feedback: string }

/** The faces of the card on screen: a term selected there can be asked about. */
const FACES = '[data-testid="question"], [data-testid="answer"]'

/**
 * The card's help, right below it: « Explain the question » in both states; before the reveal « A hint » and
 * « Answer in your own words » (graded, its grade then offered on the buttons); after it « Why? » and « A
 * mnemonic ». Each opens a panel here, guarded like the card (nothing gives the answer away before the reveal), with
 * « Continue in the chat ». A term selected on the card is asked about in the chat. Offline, all wait (said why),
 * unless the model runs on this device.
 */
export function Assists({
  card,
  revealed,
  ai,
  onGraded,
}: {
  card: CardView
  revealed: boolean
  ai: AiModelState
  onGraded: (rating: 1 | 2 | 3 | 4, feedback: string) => void
}) {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const chat = useChat()
  const online = useCanCallAi(ai)
  const offlineId = useId()
  const scopeOf = useCallback((el: Element) => el.closest(FACES), [])
  const { selected, launcher, clear } = useSelectedTerm(scopeOf)
  const [open, setOpen] = useState<AssistId | null>(null)
  const [results, setResults] = useState<Partial<Record<AssistId, Result>>>({})
  const [errors, setErrors] = useState<Partial<Record<AssistId, string>>>({})
  const [running, setRunning] = useState<AssistId | null>(null)
  const question = usePartial<QuestionExplanationDraft>()
  const answer = usePartial<CardExplanation>()
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  // The reveal changes what is offered: a panel open is closed (opened again, it shows in full what it said).
  useEffect(() => {
    if (revealed) setOpen(null)
  }, [revealed])
  const load = useMemo(() => chunkLoader(rt.ws, rt), [rt])
  const deps: AssistDeps | null = ai.status === 'ready' ? { ws: rt.ws, ai, load } : null
  const faces = { front: card.front, back: card.back }

  const labels: Record<AssistId, string> = {
    explainQuestion: t('ai.explainQuestion'),
    hint: t('chat.actionHint'),
    why: t('review.why'),
    mnemonic: t('chat.actionMnemonic'),
    ownWords: t('review.ownWords'),
  }
  const shown: AssistId[] = revealed ? ['explainQuestion', 'why', 'mnemonic'] : ['explainQuestion', 'hint', 'ownWords']

  const run = (id: AssistId, work: (signal: AbortSignal) => Promise<void>) => {
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setRunning(id)
    setErrors((e) => ({ ...e, [id]: undefined }))
    work(ctl.signal)
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return
        console.warn('assist failed', e)
        setErrors((x) => ({ ...x, [id]: t('chat.failed', { reason: describeFailure(e, t) }) }))
      })
      .finally(() => {
        if (abort.current === ctl) {
          abort.current = null
          setRunning(null)
        }
      })
  }

  const start = (id: AssistId) => {
    if (open === id) {
      setOpen(null)
      return
    }
    setOpen(id)
    // Asked once per card: opened again, it shows what it said.
    if (!deps || results[id] || id === 'ownWords') return
    if (id === 'explainQuestion' || id === 'why') {
      const kind = id === 'why' ? 'explainCard' : 'explainQuestion'
      const stream = kind === 'explainQuestion' ? question : answer
      question.reset()
      answer.reset()
      run(id, async (signal) => {
        const out = await explainRun(deps, kind, { ...faces, revealed }, card.courseId, signal, stream.onPartial)
        stream.reset()
        setResults((r) => ({ ...r, [id]: { kind: 'rich', rich: out.rich, chunks: out.chunks } }))
      })
      return
    }
    const intent: ChatIntent = id === 'hint' ? 'hint' : 'mnemonic'
    run(id, async (signal) => {
      const out = await guidedRun(
        deps,
        intent,
        labels[id],
        { ...faces, revealed },
        card.courseId,
        signal,
        (text, chunks) => setResults((r) => ({ ...r, [id]: { kind: 'text', text, chunks, done: false } })),
      )
      setResults((r) => ({ ...r, [id]: { kind: 'text', text: out.text, chunks: out.chunks, done: true } }))
    })
  }

  const grade = (typed: string) => {
    if (!deps || typed.trim() === '') return
    run('ownWords', async (signal) => {
      const g = await gradeRun(deps, faces, typed, card.courseId, signal)
      setResults((r) => ({ ...r, ownWords: { kind: 'grade', feedback: g.feedback } }))
      onGraded(g.rating, g.feedback)
    })
  }

  const askTerm = () => {
    if (!selected || !chat) return
    // A term is read in the question alone until the answer shows; a passage is sent as it is.
    const { question: q, excerpt } = askAbout(t, selected)
    chat.ask(q, selected.passage ? excerpt : revealed ? `${card.front}\n\n${card.back}` : card.front)
    clear()
  }

  const result = open ? results[open] : undefined
  const continueText = (r: Result | undefined): string =>
    r === undefined ? '' : r.kind === 'rich' ? richText(r.rich) : r.kind === 'text' ? r.text : r.feedback

  return (
    <div className={styles.assists}>
      <div ref={launcher} className={styles.actions}>
        {shown.map((id) => {
          const Icon = ICONS[id]
          return (
            <Button
              key={id}
              variant="plain"
              icon={<Icon size={18} strokeWidth={1.75} aria-hidden />}
              disabled={!online}
              aria-expanded={open === id}
              aria-describedby={online ? undefined : offlineId}
              onClick={() => start(id)}
            >
              {labels[id]}
            </Button>
          )
        })}
        {selected && chat && (
          <Button
            variant="plain"
            icon={<MessageCircle size={18} strokeWidth={1.75} aria-hidden />}
            disabled={!online}
            aria-describedby={online ? undefined : offlineId}
            onMouseDown={keepSelection}
            onClick={askTerm}
          >
            {askAbout(t, selected).label}
          </Button>
        )}
      </div>
      {!online && (
        <p id={offlineId} className={styles.note}>
          {t('ai.explainOffline')}
        </p>
      )}
      {open && (
        <section className={styles.panel} aria-label={labels[open]} aria-busy={running === open || undefined}>
          <div className={styles.head}>
            <h2 className={styles.title}>{labels[open]}</h2>
            <IconButton icon={X} label={t('common.close')} onClick={() => setOpen(null)} />
          </div>
          {open === 'ownWords' && !result && (
            <OwnWords busy={running === 'ownWords'} disabled={!online} onSubmit={grade} />
          )}
          {running === open &&
            !result &&
            open !== 'ownWords' &&
            ((open === 'explainQuestion' || open === 'why') && (question.partial || answer.partial) ? (
              <PartialRich
                kind={open === 'why' ? 'explainCard' : 'explainQuestion'}
                question={question.partial}
                answer={answer.partial}
                card={faces}
                revealed={revealed}
              />
            ) : (
              <p className={styles.muted} role="status">
                {t('chat.writing')}
              </p>
            ))}
          {running === 'ownWords' && open === 'ownWords' && (
            <p className={styles.muted} role="status">
              {t('review.checking')}
            </p>
          )}
          {result?.kind === 'rich' && (
            <RichAnswer rich={result.rich} revealed={revealed} chunks={result.chunks} courseId={card.courseId} />
          )}
          {result?.kind === 'rich' && result.rich.cost !== undefined && ai.status === 'ready' && (
            <p className={styles.muted}>
              {t('ai.cost', { amount: formatUsd(locale, result.rich.cost) })} · {ai.info.name}
            </p>
          )}
          {result?.kind === 'text' && (
            <Answer
              segments={parseCitations(result.text, [...result.chunks]).segments}
              card={{ ...faces, revealed }}
              streaming={!result.done}
            />
          )}
          {result?.kind === 'grade' && <p>{result.feedback}</p>}
          {errors[open] && (
            <p className={styles.error} role="alert">
              {errors[open]}
            </p>
          )}
          {chat && result && running !== open && (
            <div className={styles.row}>
              <Button
                variant="plain"
                icon={<MessageCircle size={18} strokeWidth={1.75} aria-hidden />}
                onClick={() => chat.ask(labels[open], continueText(result))}
              >
                {t('review.continueInChat')}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

/** The answer typed from memory, then checked against the card. */
function OwnWords({
  busy,
  disabled,
  onSubmit,
}: {
  busy: boolean
  disabled: boolean
  onSubmit: (typed: string) => void
}) {
  const t = useT()
  const [typed, setTyped] = useState('')
  return (
    <form
      className={styles.answer}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(typed)
      }}
    >
      <textarea
        className={styles.textarea}
        aria-label={t('review.yourAnswer')}
        placeholder={t('review.ownWordsPlaceholder')}
        value={typed}
        disabled={busy}
        onChange={(e) => setTyped(e.target.value)}
      />
      <div className={styles.row}>
        <Button type="submit" variant="primary" disabled={busy || disabled || typed.trim() === ''}>
          {t('review.check')}
        </Button>
      </div>
    </form>
  )
}
