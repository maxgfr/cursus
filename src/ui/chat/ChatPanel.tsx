import { Check, Copy, History, Plus, SquarePen, Trash2, X } from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link, useLocation } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspace } from '../../app/workspaceContext.tsx'
import {
  type Conversation,
  clearConversations,
  deleteConversation,
  listConversations,
  saveConversation,
} from '../../core/ai/chatStore'
import { explainCard } from '../../core/ai/features/explainCard'
import { EXPLAIN_OUTPUT_TOKENS, explainQuestion } from '../../core/ai/features/explainQuestion'
import {
  buildTutorTurn,
  type ChatContext,
  type ChatIntent,
  type ChatMessage,
  type ChatSegment,
  guardReply,
  keepValidCitations,
  parseCitations,
  type RichResult,
  richText,
  tutorChat,
} from '../../core/ai/features/tutorChat'
import type { Chunk } from '../../core/ai/retrieval'
import type { CardExplanation, QuestionExplanationDraft, SourceRef } from '../../core/ai/schemas'
import { blobStore } from '../../core/log/blobs'
import type { ModelWorkspace } from '../../core/model/workspace'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { describeFailure } from '../../screens/Review/failure.ts'
import { cardText, passagesText, useAiModel } from '../../screens/Understand/shared/aiConfig.ts'
import { Citation } from '../../screens/Understand/shared/SourcePicker.tsx'
import { chunksFor, deckReader, estimateCost } from '../../screens/Understand/shared/sources.ts'
import { Button, buttonClass } from '../components/Button.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { cx } from '../cx.ts'
import { usePartial } from '../data/usePartial.ts'
import { useCanCallAi } from '../ExplainLauncher.tsx'
import { Sanitized } from '../render/Sanitized.tsx'
import { actionById, actionsFor, type ChatAction } from './actions.ts'
import styles from './ChatPanel.module.css'
import { type ScreenContext, useChat } from './context.tsx'
import { keyed, PartialRich, RichAnswer, RichNote } from './RichAnswer.tsx'

const DOCKED = '(min-width: 1000px)'

function useDocked(): boolean {
  const [docked, setDocked] = useState(() => window.matchMedia(DOCKED).matches)
  useEffect(() => {
    const mq = window.matchMedia(DOCKED)
    const on = () => setDocked(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return docked
}

/** The chat beside the screens: docked on the right from 1000px, a sheet below. Loaded on first opening. */
export default function ChatPanel() {
  const t = useT()
  const chat = useChat()
  const docked = useDocked()
  if (!chat) return null
  if (docked) {
    // Closed, it stays mounted (hidden): the conversation is still there when it opens again.
    return (
      <aside className={styles.docked} aria-label={t('chat.title')} hidden={!chat.open}>
        <ChatBody docked onClose={chat.close} />
      </aside>
    )
  }
  return (
    <Sheet open={chat.open} title={t('chat.title')} onClose={chat.close}>
      <ChatBody docked={false} onClose={chat.close} />
    </Sheet>
  )
}

/** The screen's context with titles, as the tutor is told it. */
function describeContext(ws: ModelWorkspace, c: ScreenContext): ChatContext {
  const course = c.courseId ? ws.courses.get(c.courseId) : undefined
  const section = c.sectionId ? ws.sections.get(c.sectionId) : undefined
  const source = c.sourceId ? ws.sources.get(c.sourceId) : undefined
  return {
    ...(course ? { courseTitle: course.title } : {}),
    ...(section ? { sectionTitle: section.name } : {}),
    ...(source ? { sourceTitle: source.title } : {}),
    ...(c.card ? { card: c.card } : {}),
    ...(c.question ? { question: c.question } : {}),
  }
}

interface Live {
  text: string
  chunks: Chunk[]
}

/** A structured answer being written: which one, about which card. */
interface LiveRich {
  kind: RichResult['kind']
  card: { front: string; back: string; revealed: boolean }
}

type Card = NonNullable<ScreenContext['card']>

/** Whether a structured answer about `faces` may show in full: always, unless that card is on screen unrevealed. */
const revealedFor = (faces: { front: string; back: string }, card: ScreenContext['card']) =>
  !(card && !card.revealed && card.front === faces.front && card.back === faces.back)

function ChatBody({ docked, onClose }: { docked: boolean; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [, navigate] = useLocation()
  const ws = useWorkspace()
  const rt = useRuntime()
  const chat = useChat()
  const ai = useAiModel()
  const callable = useCanCallAi(ai)
  const screen = chat?.context ?? {}
  const screenKey = JSON.stringify(screen)
  const [detached, setDetached] = useState<string | null>(null)
  // Removing the context lasts until the screen shows something else.
  const screenOn = detached !== screenKey
  const context: ScreenContext = screenOn ? screen : {}
  const courseId = screen.courseId
  const course = courseId ? ws.courses.get(courseId) : undefined

  const [chats, setChats] = useState<Conversation[]>([])
  const [current, setCurrent] = useState<{ id: string; messages: ChatMessage[]; courseId?: string }>(() => ({
    id: rt.rng.id(),
    messages: [],
    ...(courseId ? { courseId } : {}),
  }))
  const [showHistory, setShowHistory] = useState(false)
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState<Live | null>(null)
  const [liveRich, setLiveRich] = useState<LiveRich | null>(null)
  const [courseChunks, setCourseChunks] = useState<Chunk[]>([])
  const questionStream = usePartial<QuestionExplanationDraft>()
  const answerStream = usePartial<CardExplanation>()
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const chunkCache = useRef(new Map<string, Promise<Chunk[]>>())
  const input = useRef<HTMLTextAreaElement>(null)
  const log = useRef<HTMLDivElement>(null)

  useEffect(() => () => abort.current?.abort(), [])

  // Conversations are kept per course: another course opens on a new chat, its earlier ones listed.
  useEffect(() => {
    let alive = true
    listConversations(rt.store, courseId).then(
      (list) => alive && setChats(list),
      (e: unknown) => console.warn('chats unavailable', e),
    )
    setCurrent((c) =>
      c.courseId === courseId ? c : { id: rt.rng.id(), messages: [], ...(courseId ? { courseId } : {}) },
    )
    return () => {
      alive = false
    }
  }, [rt, courseId])

  useEffect(() => {
    if (chat?.open) input.current?.focus({ preventScroll: true })
  }, [chat?.open])

  // Follows the answer as it streams, unless the student scrolled up to read.
  useEffect(() => {
    const el = log.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  })

  const loadChunks = useCallback(
    (ids: string[]): Promise<Chunk[]> => {
      const key = ids.join(',')
      let loading = chunkCache.current.get(key)
      if (!loading) {
        loading = chunksFor(ws, blobStore(rt.store), ids, '', deckReader(rt))
        chunkCache.current.set(key, loading)
        loading.catch(() => chunkCache.current.delete(key))
      }
      return loading
    },
    [ws, rt],
  )

  const persist = useCallback(
    (id: string, messages: ChatMessage[], forCourse: string | undefined) => {
      saveConversation(rt.store, forCourse, { id, messages, updatedAt: Date.now() }).then(
        (list) => {
          if (forCourse === courseId) setChats(list)
        },
        (e: unknown) => console.warn('chat not saved', e),
      )
    },
    [rt, courseId],
  )

  // The course's passages, from which the structured answers quote what they cite.
  const hasRich = current.messages.some((m) => m.rich !== undefined)
  useEffect(() => {
    if (!hasRich) return
    let alive = true
    const ids = courseId ? ws.sources.list({ courseId }).map((s) => s.id) : []
    loadChunks(ids).then(
      (loaded) => alive && setCourseChunks(loaded),
      (e: unknown) => console.warn('Course passages could not be read', e),
    )
    return () => {
      alive = false
    }
  }, [hasRich, courseId, ws, loadChunks])

  const ask = useCallback(
    async (history: ChatMessage[], { excerpt, intent }: { excerpt?: string; intent?: ChatIntent } = {}) => {
      if (ai.status !== 'ready') return
      abort.current?.abort()
      const ctl = new AbortController()
      abort.current = ctl
      const conv = current
      setCurrent({ ...conv, messages: history })
      setError(null)
      setLive({ text: '', chunks: [] })
      let text = ''
      let grounded: Chunk[] = []
      try {
        // A summary reads its source; within a course its sources; elsewhere, or without the screen, the library.
        const scoped = screenOn && courseId !== undefined
        const ids =
          intent === 'summarise' && context.sourceId
            ? [context.sourceId]
            : ws.sources.list(scoped ? { courseId } : undefined).map((s) => s.id)
        const chunks = await loadChunks(ids)
        // Written in the language of what is on screen: the card, else the open source, else the course's sources.
        const ctx = await ai.context(ctl.signal, course?.language, [
          cardText(context.card),
          passagesText(chunks.filter((c) => c.sourceId === context.sourceId)),
          passagesText(chunks),
        ])
        const about = {
          ...describeContext(ws, context),
          ...(excerpt ? { excerpt } : {}),
          ...(intent ? { intent } : {}),
        }
        const turn = buildTutorTurn(about, history, chunks, ctx.info, ctx.language)
        grounded = turn.chunks
        for await (const delta of tutorChat(ctx, turn)) {
          text += delta
          setLive({ text, chunks: grounded })
        }
      } catch (e) {
        if (!ctl.signal.aborted) {
          console.warn('chat answer failed', e)
          setError(t('chat.failed', { reason: describeFailure(e, t) }))
        }
      }
      if (abort.current === ctl) abort.current = null
      setLive(null)
      const kept = keepValidCitations(text, grounded).trim()
      const stopped = ctl.signal.aborted
      if (kept === '' && !stopped) return
      const messages: ChatMessage[] = [
        ...history,
        { role: 'assistant', text: stopped ? `${kept}${kept ? '\n\n' : ''}${t('chat.stopped')}` : kept },
      ]
      setCurrent((c) => (c.id === conv.id ? { ...c, messages } : c))
      persist(conv.id, messages, conv.courseId)
    },
    [ai, current, screenOn, courseId, ws, loadChunks, course, context, t, persist],
  )

  // « Explain the question » and « Why? »: a structured answer, written into the thread as it comes.
  const explain = useCallback(
    async (kind: RichResult['kind'], label: string, card: Card) => {
      if (ai.status !== 'ready') return
      abort.current?.abort()
      const ctl = new AbortController()
      abort.current = ctl
      const conv = current
      const history: ChatMessage[] = [...conv.messages, { role: 'user', text: label }]
      setCurrent({ ...conv, messages: history })
      setError(null)
      const stream = kind === 'explainQuestion' ? questionStream : answerStream
      questionStream.reset()
      answerStream.reset()
      setLiveRich({ kind, card })
      let rich: RichResult | null = null
      try {
        const ids = courseId ? ws.sources.list({ courseId }).map((s) => s.id) : []
        const loaded = await loadChunks(ids)
        setCourseChunks(loaded)
        const cost = estimateCost(ai.info, loaded, EXPLAIN_OUTPUT_TOKENS)
        const content = [cardText(card), passagesText(loaded)]
        const ctx = { ...(await ai.context(ctl.signal, course?.language, content)), onPartial: stream.onPartial }
        const input = { chunks: loaded, courseTitle: course?.title }
        const faces = { front: card.front, back: card.back }
        rich =
          kind === 'explainQuestion'
            ? {
                kind,
                card: faces,
                cost,
                value: await explainQuestion(ctx, { card: faces, revealed: card.revealed, ...input }),
              }
            : { kind, card: faces, cost, value: await explainCard(ctx, { ...faces, ...input }) }
      } catch (e) {
        if (!ctl.signal.aborted) {
          console.warn('Explanation request failed', e)
          setError(t('chat.failed', { reason: describeFailure(e, t) }))
        }
      }
      if (abort.current === ctl) abort.current = null
      stream.reset()
      setLiveRich(null)
      if (rich === null || ctl.signal.aborted) return
      const messages: ChatMessage[] = [...history, { role: 'assistant', text: richText(rich), rich }]
      setCurrent((c) => (c.id === conv.id ? { ...c, messages } : c))
      persist(conv.id, messages, conv.courseId)
    },
    [ai, current, courseId, ws, loadChunks, course, t, persist, questionStream, answerStream],
  )

  const busy = live !== null || liveRich !== null

  const perform = useCallback(
    (action: ChatAction, on: ScreenContext) => {
      if (action.kind === 'link') {
        navigate(action.href)
        return
      }
      if (action.kind === 'guided') {
        void ask([...current.messages, { role: 'user', text: action.label }], { intent: action.intent })
        return
      }
      const card = on.card
      if (!card) return
      const kind = action.id === 'why' ? 'explainCard' : 'explainQuestion'
      // An explanation of this card already in the thread is shown again, not asked again.
      const given = current.messages.some(
        (m) => m.rich?.kind === kind && m.rich.card.front === card.front && m.rich.card.back === card.back,
      )
      if (!given) void explain(kind, action.label, card)
    },
    [navigate, ask, current.messages, explain],
  )

  // Run from the screen (« Explain the question » in review): as soon as the chat can, with the screen's context.
  const running = chat?.running
  const ran = useRef<number | null>(null)
  useEffect(() => {
    if (!running || ran.current === running.seq) return
    // Waits for the course's conversation when the screen just moved to another course.
    if (ai.status !== 'ready' || !callable || busy || current.courseId !== courseId) return
    ran.current = running.seq
    setShowHistory(false)
    setDetached(null)
    const action = actionById(t, screen, running.id)
    if (action) perform(action, screen)
    else console.warn(`Chat action "${running.id}" has nothing to act on here`)
  }, [running, ai.status, callable, busy, current.courseId, courseId, t, screen, perform])

  // Asked from the screen (a term selected there): sent as soon as the chat can answer, in the chat on screen.
  const asked = chat?.asked
  const handled = useRef<number | null>(null)
  useEffect(() => {
    if (!asked || handled.current === asked.seq) return
    if (ai.status !== 'ready' || !callable || busy) return
    handled.current = asked.seq
    setShowHistory(false)
    void ask([...current.messages, { role: 'user', text: asked.text }], asked.excerpt ? { excerpt: asked.excerpt } : {})
  }, [asked, ai.status, callable, busy, current.messages, ask])

  const send = (text: string) => {
    const q = text.trim()
    if (q === '' || busy || !callable) return
    setDraft('')
    void ask([...current.messages, { role: 'user', text: q }])
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    send(draft)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send(draft)
    }
  }

  const stop = () => abort.current?.abort()

  const startNew = () => {
    abort.current?.abort()
    setError(null)
    setShowHistory(false)
    setCurrent({ id: rt.rng.id(), messages: [], ...(courseId ? { courseId } : {}) })
    input.current?.focus()
  }

  const retry = () => {
    const history = current.messages
    if (history.at(-1)?.role === 'user') void ask(history)
  }

  // On a phone the sheet covers the page: following a citation or a link closes it.
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = body.current
    if (!el || docked) return
    const onClick = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('a')) onClose()
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  })

  const chip = chipLabel(t, ws, screen)
  const actions = actionsFor(t, context)
  const card = context.card
  const costOf = (rich: RichResult) =>
    rich.cost === undefined || ai.status !== 'ready'
      ? null
      : `${t('ai.cost', { amount: formatUsd(locale, rich.cost) })} · ${ai.info.name}`

  const contextChip = screenOn ? (
    <span className={styles.chip}>
      <span className={styles.chipText}>{t('chat.about', { what: chip })}</span>
      {chip !== t('chat.aboutLibrary') && (
        <button
          type="button"
          className={styles.chipRemove}
          aria-label={t('chat.removeContext')}
          title={t('chat.removeContext')}
          onClick={() => setDetached(screenKey)}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </span>
  ) : (
    <span className={styles.chip}>
      <span className={styles.chipText}>{t('chat.wholeLibrary')}</span>
      <button type="button" className={styles.chipAction} onClick={() => setDetached(null)}>
        {t('chat.useScreen')}
      </button>
    </span>
  )

  // Docked, the panel carries its own title; in the sheet (titled already) the context shares the tools' row.
  const toolbar = (
    <div className={styles.toolbar}>
      {docked ? (
        <h2 className={styles.title}>{t('chat.title')}</h2>
      ) : (
        ai.status === 'ready' && !showHistory && <div className={styles.context}>{contextChip}</div>
      )}
      <div className={styles.tools}>
        <IconButton
          icon={History}
          label={t('chat.history')}
          aria-pressed={showHistory}
          onClick={() => setShowHistory((s) => !s)}
        />
        <IconButton icon={SquarePen} label={t('chat.newChat')} onClick={startNew} />
        {docked && <IconButton icon={X} label={t('chat.closePanel')} onClick={onClose} />}
      </div>
    </div>
  )

  if (ai.status === 'loading') return toolbar
  if (ai.status === 'missing') {
    return (
      <div className={styles.body}>
        {toolbar}
        <div className={styles.setup}>
          <p className={styles.setupTitle}>{t('chat.setupTitle')}</p>
          <p className={styles.muted}>{t('chat.setupBody')}</p>
          <Link
            href={paths.settingsAi}
            className={buttonClass({ variant: 'primary' })}
            onClick={docked ? undefined : onClose}
          >
            {t('chat.setup')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div ref={body} className={styles.body}>
      {toolbar}
      {showHistory ? (
        <HistoryList
          chats={chats}
          currentId={current.id}
          onOpen={(c) => {
            abort.current?.abort()
            setCurrent({ id: c.id, messages: c.messages, ...(courseId ? { courseId } : {}) })
            setShowHistory(false)
          }}
          onDelete={(c) => {
            deleteConversation(rt.store, courseId, c.id).then(setChats, (e: unknown) => console.warn(e))
            // The list stays open: the chat on screen becomes a new one.
            if (c.id === current.id) setCurrent({ id: rt.rng.id(), messages: [], ...(courseId ? { courseId } : {}) })
          }}
          onClear={() => {
            clearConversations(rt.store, courseId).then(
              () => setChats([]),
              (e: unknown) => console.warn(e),
            )
            startNew()
          }}
        />
      ) : (
        <>
          {docked && <div className={styles.context}>{contextChip}</div>}
          {actions.length > 0 && (
            <ul className={styles.actionRow} aria-label={t('chat.actions')}>
              {actions.map((a) => (
                <li key={a.id}>
                  {a.kind === 'link' ? (
                    <Link href={a.href} className={styles.suggestion}>
                      {a.label}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className={styles.suggestion}
                      disabled={!callable || busy}
                      onClick={() => perform(a, context)}
                    >
                      {a.label}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div ref={log} className={styles.log} role="log" aria-label={t('chat.title')} aria-busy={busy || undefined}>
            {current.messages.length === 0 && !busy && (
              <div className={styles.intro}>
                <p className={styles.muted}>{t('chat.intro')}</p>
              </div>
            )}
            {keyed(
              current.messages.map((m, at) => ({ m, before: current.messages[at - 1] })),
              ({ m }) => `${m.role}:${m.text}`,
            ).map(({ item: { m, before }, key }) => {
              if (!m.rich) {
                return (
                  <Message
                    key={key}
                    message={m}
                    question={before?.role === 'user' ? before.text : undefined}
                    card={card}
                    courseId={courseId}
                    sectionId={context.sectionId}
                  />
                )
              }
              const cost = costOf(m.rich)
              return (
                <div key={key} className={styles.answer}>
                  <span className="sr-only">{t('chat.tutor')}: </span>
                  <RichAnswer
                    rich={m.rich}
                    revealed={revealedFor(m.rich.card, screen.card)}
                    chunks={courseChunks}
                    courseId={current.courseId}
                    footer={cost && <RichNote>{cost}</RichNote>}
                  />
                </div>
              )
            })}
            {liveRich && (
              <div className={styles.answer}>
                <span className="sr-only">{t('chat.tutor')}: </span>
                {questionStream.partial || answerStream.partial ? (
                  <PartialRich
                    kind={liveRich.kind}
                    question={questionStream.partial}
                    answer={answerStream.partial}
                    card={liveRich.card}
                    revealed={revealedFor(liveRich.card, screen.card)}
                  />
                ) : (
                  <p className={styles.muted} role="status">
                    {t('chat.writing')}
                  </p>
                )}
              </div>
            )}
            {live && (
              <Answer segments={parseCitations(live.text, live.chunks).segments} card={card} streaming>
                {live.text === '' && (
                  <p className={styles.muted} role="status">
                    {t('chat.writing')}
                  </p>
                )}
              </Answer>
            )}
            {error && (
              <div className={styles.error} role="alert">
                <p>{error}</p>
                <Button variant="plain" onClick={retry}>
                  {t('chat.retry')}
                </Button>
              </div>
            )}
          </div>
          {!callable && <p className={styles.note}>{t('chat.offline')}</p>}
          <form className={styles.composer} onSubmit={submit}>
            <label className="sr-only" htmlFor={`${current.id}-q`}>
              {t('chat.inputLabel')}
            </label>
            <textarea
              id={`${current.id}-q`}
              ref={input}
              className={styles.input}
              rows={2}
              value={draft}
              placeholder={t('chat.placeholder')}
              disabled={!callable}
              enterKeyHint="send"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {busy ? (
              <Button variant="secondary" onClick={stop}>
                {t('chat.stop')}
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!callable || draft.trim() === ''}>
                {t('chat.send')}
              </Button>
            )}
          </form>
        </>
      )}
    </div>
  )
}

function chipLabel(t: ReturnType<typeof useT>, ws: ModelWorkspace, c: ScreenContext): string {
  if (c.card) return t('chat.aboutCard')
  if (c.question) return t('chat.aboutQuestion')
  const source = c.sourceId ? ws.sources.get(c.sourceId) : undefined
  if (source) return source.title
  const section = c.sectionId ? ws.sections.get(c.sectionId) : undefined
  if (section) return section.name
  const course = c.courseId ? ws.courses.get(c.courseId) : undefined
  if (course) return course.title
  return t('chat.aboutLibrary')
}

/** The answer's text, citations removed, for a card or the clipboard. */
const plainText = (segments: readonly ChatSegment[]) =>
  segments
    .flatMap((s) => (s.kind === 'text' ? [s.text] : []))
    .join('')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim()

function Message({
  message,
  question,
  card,
  courseId,
  sectionId,
}: {
  message: ChatMessage
  question: string | undefined
  card: ScreenContext['card']
  courseId: string | undefined
  sectionId: string | undefined
}) {
  const t = useT()
  if (message.role === 'user') {
    return (
      <div className={styles.user}>
        <span className="sr-only">{t('chat.you')}: </span>
        {message.text}
      </div>
    )
  }
  const segments = parseCitations(message.text).segments
  return (
    <Answer segments={segments} card={card}>
      <AnswerActions segments={segments} question={question} courseId={courseId} sectionId={sectionId} card={card} />
    </Answer>
  )
}

/** A cited passage's address: the source, at its page, slide or section when there is one. */
const citeHref = (ref: SourceRef) =>
  ref.page === undefined ? to.source(ref.sourceId) : `${to.source(ref.sourceId)}?page=${ref.page}`

/**
 * The answer as Markdown, its citations numbered in order of first use (`[1]` links to the passage, the sources
 * are listed by name below). A streamed answer ends with a cursor.
 */
function answerMarkdown(segments: readonly ChatSegment[], streaming: boolean): { markdown: string; refs: SourceRef[] } {
  const order = new Map<string, number>()
  const refs: SourceRef[] = []
  let markdown = ''
  for (const s of segments) {
    if (s.kind === 'text') {
      markdown += s.text
      continue
    }
    const key = `${s.ref.sourceId}\u0000${s.ref.page ?? ''}`
    let n = order.get(key)
    if (n === undefined) {
      refs.push(s.ref)
      n = refs.length
      order.set(key, n)
    }
    markdown += ` [${n}](#${citeHref(s.ref)})`
  }
  return { markdown: streaming && markdown !== '' ? `${markdown} ▍` : markdown, refs }
}

function Answer({
  segments,
  card,
  streaming = false,
  children,
}: {
  segments: ChatSegment[]
  card: ScreenContext['card']
  streaming?: boolean
  children?: ReactNode
}) {
  const t = useT()
  const guarded = guardReply(segments, card)
  const { markdown, refs } = answerMarkdown(guarded.segments, streaming)
  return (
    <div className={styles.answer}>
      <span className="sr-only">{t('chat.tutor')}: </span>
      {markdown !== '' && (
        <div className={styles.answerText}>
          <Sanitized markdown={markdown} />
        </div>
      )}
      {refs.length > 0 && (
        <ol className={styles.sources} aria-label={t('chat.sources')}>
          {refs.map((ref, i) => (
            <li key={`${ref.sourceId}/${ref.page ?? ''}`} className={styles.source}>
              <span className={styles.sourceNumber} aria-hidden="true">
                {i + 1}
              </span>
              <Citation sourceRef={ref} />
            </li>
          ))}
        </ol>
      )}
      {guarded.leaked && <p className={styles.note}>{t('chat.hidden')}</p>}
      {children}
    </div>
  )
}

function AnswerActions({
  segments,
  question,
  courseId,
  sectionId,
  card,
}: {
  segments: ChatSegment[]
  question: string | undefined
  courseId: string | undefined
  sectionId: string | undefined
  card: ScreenContext['card']
}) {
  const t = useT()
  const ws = useWorkspace()
  const status = useId()
  const [made, setMade] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => plainText(segments), [segments])
  // Before the reveal an answer is not copied or turned into a card: that would show it.
  if (text === '' || (card && !card.revealed)) return null

  const makeCard = () => {
    if (!courseId) return
    const id = ws.batch(() => {
      const id = ws.cards.create({ courseId, ...(sectionId ? { sectionId } : {}), kind: 'basic', origin: 'ai' })
      ws.text({ id, field: 'front' }).insert(0, question?.trim() || text.split('\n')[0] || text)
      ws.text({ id, field: 'back' }).insert(0, text)
      return id
    })
    setMade(id)
  }

  const copy = () => {
    navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      (e: unknown) => console.warn('copy failed', e),
    )
  }

  return (
    <div className={styles.actions}>
      {courseId && (
        <Button
          variant="plain"
          icon={<Plus size={16} strokeWidth={1.75} aria-hidden />}
          disabled={made !== null}
          aria-describedby={made ? status : undefined}
          onClick={makeCard}
        >
          {t('chat.makeCard')}
        </Button>
      )}
      <Button
        variant="plain"
        icon={
          copied ? (
            <Check size={16} strokeWidth={1.75} aria-hidden />
          ) : (
            <Copy size={16} strokeWidth={1.75} aria-hidden />
          )
        }
        onClick={copy}
      >
        {copied ? t('chat.copied') : t('chat.copy')}
      </Button>
      {made && courseId && (
        <p id={status} className={styles.made} role="status">
          {t('chat.cardMade', { course: ws.courses.get(courseId)?.title ?? '' })}{' '}
          <Link href={to.card(made)}>{t('chat.editCard')}</Link>
        </p>
      )}
    </div>
  )
}

function HistoryList({
  chats,
  currentId,
  onOpen,
  onDelete,
  onClear,
}: {
  chats: readonly Conversation[]
  currentId: string
  onOpen: (c: Conversation) => void
  onDelete: (c: Conversation) => void
  onClear: () => void
}) {
  const t = useT()
  if (chats.length === 0) return <p className={cx(styles.muted, styles.pad)}>{t('chat.historyEmpty')}</p>
  return (
    <div className={styles.history}>
      <ul className={styles.historyList}>
        {chats.map((c) => {
          const title = c.title || t('chat.untitled')
          return (
            <li key={c.id} className={styles.historyRow}>
              <button
                type="button"
                className={styles.historyOpen}
                aria-current={c.id === currentId || undefined}
                aria-label={t('chat.openChat', { title })}
                onClick={() => onOpen(c)}
              >
                {title}
              </button>
              <IconButton icon={Trash2} label={t('chat.deleteChat', { title })} onClick={() => onDelete(c)} />
            </li>
          )
        })}
      </ul>
      <Button variant="plain" onClick={onClear}>
        {t('chat.clearAll')}
      </Button>
    </div>
  )
}
