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
import { Link } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspace } from '../../app/workspaceContext.tsx'
import {
  type Conversation,
  clearConversations,
  deleteConversation,
  listConversations,
  saveConversation,
} from '../../core/ai/chatStore'
import {
  buildTutorTurn,
  type ChatContext,
  type ChatMessage,
  type ChatSegment,
  guardReply,
  keepValidCitations,
  parseCitations,
  tutorChat,
} from '../../core/ai/features/tutorChat'
import type { Chunk } from '../../core/ai/retrieval'
import type { SourceRef } from '../../core/ai/schemas'
import { blobStore } from '../../core/log/blobs'
import type { ModelWorkspace } from '../../core/model/workspace'
import { useT } from '../../i18n/react.tsx'
import { describeFailure } from '../../screens/Review/failure.ts'
import { useAiModel } from '../../screens/Understand/shared/aiConfig.ts'
import { Citation } from '../../screens/Understand/shared/SourcePicker.tsx'
import { chunksFor, deckReader } from '../../screens/Understand/shared/sources.ts'
import { Button, buttonClass } from '../components/Button.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { cx } from '../cx.ts'
import { useCanCallAi } from '../ExplainLauncher.tsx'
import { Sanitized } from '../render/Sanitized.tsx'
import styles from './ChatPanel.module.css'
import { type ScreenContext, useChat } from './context.tsx'

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

/** Items with a React key from their content, repeats told apart by their rank among equals. */
function keyed<T>(items: readonly T[], keyOf: (item: T) => string): { item: T; key: string }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = keyOf(item)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return { item, key: n === 1 ? base : `${base}#${n}` }
  })
}

function ChatBody({ docked, onClose }: { docked: boolean; onClose: () => void }) {
  const t = useT()
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

  // Opened on an explanation: a new chat that starts from it.
  const seed = chat?.seed
  const seeded = useRef<number | null>(null)
  useEffect(() => {
    if (!seed || seeded.current === seed.seq) return
    seeded.current = seed.seq
    abort.current?.abort()
    setShowHistory(false)
    setCurrent({
      id: rt.rng.id(),
      messages: [{ role: 'assistant', text: seed.text }],
      ...(courseId ? { courseId } : {}),
    })
  }, [seed, rt, courseId])

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

  const ask = useCallback(
    async (history: ChatMessage[], excerpt?: string) => {
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
        // Within a course its sources; elsewhere, or without the screen, the whole library.
        const scoped = screenOn && courseId !== undefined
        const ids = ws.sources.list(scoped ? { courseId } : undefined).map((s) => s.id)
        const chunks = await loadChunks(ids)
        const ctx = await ai.context(ctl.signal, course?.language)
        const about = { ...describeContext(ws, context), ...(excerpt ? { excerpt } : {}) }
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

  // Asked from the screen (a term selected there): sent as soon as the chat can answer, in the chat on screen.
  const asked = chat?.asked
  const handled = useRef<number | null>(null)
  useEffect(() => {
    if (!asked || handled.current === asked.seq) return
    if (ai.status !== 'ready' || !callable || live !== null) return
    handled.current = asked.seq
    setShowHistory(false)
    void ask([...current.messages, { role: 'user', text: asked.text }], asked.excerpt)
  }, [asked, ai.status, callable, live, current.messages, ask])

  const send = (text: string) => {
    const q = text.trim()
    if (q === '' || live !== null || !callable) return
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
  const suggestions = suggestionsFor(t, context)
  const card = context.card
  const busy = live !== null

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
          <div ref={log} className={styles.log} role="log" aria-label={t('chat.title')} aria-busy={busy || undefined}>
            {current.messages.length === 0 && !busy && (
              <div className={styles.intro}>
                <p className={styles.muted}>{t('chat.intro')}</p>
                <ul className={styles.suggestions}>
                  {suggestions.map((s) => (
                    <li key={s}>
                      <button type="button" className={styles.suggestion} disabled={!callable} onClick={() => send(s)}>
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {keyed(
              current.messages.map((m, at) => ({ m, before: current.messages[at - 1] })),
              ({ m }) => `${m.role}:${m.text}`,
            ).map(({ item: { m, before }, key }) => (
              <Message
                key={key}
                message={m}
                question={before?.role === 'user' ? before.text : undefined}
                card={card}
                courseId={courseId}
                sectionId={context.sectionId}
              />
            ))}
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

function suggestionsFor(t: ReturnType<typeof useT>, c: ScreenContext): string[] {
  const out: string[] = []
  if (c.card) out.push(c.card.revealed ? t('chat.suggestExplainCard') : t('chat.suggestThinkCard'))
  if (c.question) out.push(t('chat.suggestQuestion'))
  if (c.sourceId) out.push(t('chat.suggestSummarise'))
  if (c.sectionId) out.push(t('chat.suggestQuizSection'))
  else if (c.courseId) out.push(t('chat.suggestQuizCourse'))
  if (out.length < 3) out.push(t('chat.suggestConcept'))
  return out.slice(0, 3)
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
