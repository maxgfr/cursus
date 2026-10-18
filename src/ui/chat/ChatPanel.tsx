import { Check, Copy, History, Maximize2, Minimize2, Plus, SquarePen, Trash2, X } from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
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
import { canSeeImages, loadReadings } from '../../core/ai/features/describePhoto'
import {
  buildTutorTurn,
  type ChatContext,
  type ChatIntent,
  type ChatMessage,
  type ChatSegment,
  isCardRich,
  keepValidCitations,
  parseCitations,
  tutorChat,
  type UnreadPhoto,
} from '../../core/ai/features/tutorChat'
import { readWritten } from '../../core/ai/features/writtenContext'
import type { Chunk } from '../../core/ai/retrieval'
import { isPhoto } from '../../core/model/photos'
import { weakCards } from '../../core/model/quizPlan'
import type { SourceRecord } from '../../core/model/schema'
import type { ModelWorkspace } from '../../core/model/workspace'
import { useT } from '../../i18n/react.tsx'
import { describeFailure } from '../../screens/Review/failure.ts'
import { cardText, passagesText, useAiModel } from '../../screens/Understand/shared/aiConfig.ts'
import { Button, buttonClass } from '../components/Button.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { cx } from '../cx.ts'
import { useCanCallAi } from '../ExplainLauncher.tsx'
import { Answer } from './Answer.tsx'
import { AttachedPhoto } from './AttachedPhoto.tsx'
import { actionsFor } from './actions.ts'
import styles from './ChatPanel.module.css'
import { type ScreenContext, useChat } from './context.tsx'
import { LegacyAnswer } from './LegacyAnswer.tsx'
import { usePhotoImages } from './photoImages.ts'
import { ResizeHandle } from './ResizeHandle.tsx'
import { keyed } from './RichAnswer.tsx'
import { chunkLoader } from './studyRun.ts'

const DOCKED = '(min-width: 1000px)'
/** Photos not read yet sent along with a question, at most: each costs as much as a page of text. */
const ATTACHED_PHOTOS = 3

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

/**
 * The chat beside the screens, to talk about what is on them: from 1000px it opens across the page's whole room
 * (expanded) or as a column docked on the right (restored), as last chosen on this device; below it the whole
 * screen over the page. It only converses, cited, with
 * « Copy » and « Make a card » (a suggested card); each AI feature has its own place on its screen. Earlier threads
 * keep their structured answers, read only. Loaded on first opening.
 */
export default function ChatPanel() {
  const t = useT()
  const chat = useChat()
  const docked = useDocked()
  if (!chat) return null
  if (docked) {
    // Closed, it stays mounted (hidden): the conversation is still there when it opens again.
    return (
      <aside
        className={cx(styles.docked, chat.expanded && styles.expanded)}
        aria-label={t('chat.title')}
        hidden={!chat.open}
      >
        {!chat.expanded && <ResizeHandle />}
        <ChatBody docked onClose={chat.close} />
      </aside>
    )
  }
  return (
    <Sheet open={chat.open} title={t('chat.title')} onClose={chat.close} fill fullscreen>
      <ChatBody docked={false} onClose={chat.close} />
    </Sheet>
  )
}

/** The screen's context with titles, as the tutor is told it. */
function describeContext(ws: ModelWorkspace, c: ScreenContext): ChatContext {
  const course = c.courseId ? ws.courses.get(c.courseId) : undefined
  const section = c.sectionId ? ws.sections.get(c.sectionId) : undefined
  // A photo open is a source of the course too.
  const sourceId = c.sourceId ?? c.photoId
  const source = sourceId ? ws.sources.get(sourceId) : undefined
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
  const [courseChunks, setCourseChunks] = useState<Chunk[]>([])
  const [error, setError] = useState<string | null>(null)
  const load = useMemo(() => chunkLoader(ws, rt), [ws, rt])
  const abort = useRef<AbortController | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const busy = live !== null
  const actionList = useRef<HTMLUListElement>(null)
  const [actionsMore, setActionsMore] = useState<'start' | 'end' | 'both' | null>(null)
  const measureActions = useCallback(() => {
    const el = actionList.current
    if (!el) return
    const before = el.scrollLeft > 1
    const after = el.scrollWidth - el.clientWidth - el.scrollLeft > 1
    setActionsMore(before && after ? 'both' : before ? 'start' : after ? 'end' : null)
  }, [])
  useEffect(() => {
    const el = actionList.current
    if (!el || typeof ResizeObserver === 'undefined') return
    measureActions()
    const seen = new ResizeObserver(measureActions)
    seen.observe(el)
    return () => seen.disconnect()
  })

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

  // The question box takes the focus on opening, or as soon as it shows once the model is known.
  const status = ai.status
  useEffect(() => {
    if (chat?.open && status === 'ready') input.current?.focus({ preventScroll: true })
  }, [chat?.open, status])

  // A new message or the panel opening shows the end of the thread; a streaming answer is followed unless the
  // student scrolled up to read.
  const count = current.messages.length
  const shownCount = useRef(-1)
  useLayoutEffect(() => {
    const el = log.current
    if (!el) return
    const added = count !== shownCount.current
    shownCount.current = count
    if (added || el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  })
  useEffect(() => {
    if (!chat?.open) return
    shownCount.current = -1
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat?.open])

  // The same reading as the study screens: a photo's caption, notes and what a model read on it included.
  const loadChunks = useCallback((ids: string[]): Promise<Chunk[]> => load({ sourceIds: ids, pasted: '' }), [load])

  // Photos nothing was read on yet are sources all the same: a model that sees images gets a reduced copy of a few
  // (the one on screen first), else they are named as not read yet, and the thread offers to read them.
  const images = usePhotoImages()
  const [unread, setUnread] = useState<{ id: string; photoIds: string[] } | null>(null)
  const unreadPhotos = useCallback(
    async (photos: readonly SourceRecord[], onScreen: string | undefined): Promise<UnreadPhoto[]> => {
      if (photos.length === 0 || ai.status !== 'ready') return []
      const readings = await loadReadings(
        rt.store,
        photos.map((p) => p.id),
      )
      const read = new Set(readings.map((r) => r.photoId))
      const left = photos
        .filter((p) => !read.has(p.id))
        .sort((a, b) => Number(b.id === onScreen) - Number(a.id === onScreen))
      const sees = canSeeImages(ai.info)
      return Promise.all(
        left.map(async (p, i): Promise<UnreadPhoto> => {
          const named = { photoId: p.id, title: p.title, ...(p.caption ? { caption: p.caption } : {}) }
          if (!sees || i >= ATTACHED_PHOTOS) return named
          // Not on this device yet (on-demand files): named, as a photo not read.
          const image = await images(p.id).catch(() => undefined)
          return image ? { ...named, image } : named
        }),
      )
    },
    [ai, rt, images],
  )

  // Saved one after another, in the order they happened: two quick changes (a card saved, then all the others)
  // never land the older one last.
  const saving = useRef<Promise<void>>(Promise.resolve())
  const persist = useCallback(
    (id: string, messages: ChatMessage[], forCourse: string | undefined) => {
      const updatedAt = Date.now()
      saving.current = saving.current
        .then(() => saveConversation(rt.store, forCourse, { id, messages, updatedAt }))
        .then(
          (list) => {
            if (forCourse === courseId) setChats(list)
          },
          (e: unknown) => console.warn('chat not saved', e),
        )
    },
    [rt, courseId],
  )

  // The course's passages, from which an earlier thread's explanations quote what they cite.
  const hasRich = current.messages.some((m) => m.rich !== undefined && isCardRich(m.rich))
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
      let notRead: string[] = []
      try {
        // Within a course its sources; elsewhere, or without the screen, the library.
        const scoped = screenOn && courseId !== undefined
        const sources = ws.sources.list(scoped ? { courseId } : undefined)
        const chunks = await loadChunks(sources.map((s) => s.id))
        // Within a course, what the student wrote there and its photos nothing was read on yet count too.
        const photos = scoped ? await unreadPhotos(sources.filter(isPhoto), context.photoId) : []
        notRead = photos.flatMap((p) => (p.image ? [] : [p.photoId]))
        const place = scoped ? { courseId, ...(context.sectionId ? { sectionId: context.sectionId } : {}) } : null
        const onCard =
          context.cardId && context.card ? { id: context.cardId, hidden: !context.card.revealed } : undefined
        const weak =
          place && intent === 'whatToReview' ? weakCards(ws, place, Date.now()).map((w) => w.front) : undefined
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
          ...(weak ? { weak } : {}),
        }
        const turn = buildTutorTurn(about, history, chunks, ctx.info, ctx.language, undefined, {
          ...(place ? { written: readWritten(ws, place, onCard) } : {}),
          photos,
        })
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
      setUnread({ id: conv.id, photoIds: notRead })
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
    [ai, current, screenOn, courseId, ws, loadChunks, unreadPhotos, course, context, t, persist],
  )

  const settle = chat?.settle
  // Asked from the screen (a term selected there): sent as soon as the chat can answer, in the chat on screen.
  const asked = chat?.asked
  const handled = useRef<number | null>(null)
  useEffect(() => {
    if (!asked || handled.current === asked.seq) return
    if (ai.status !== 'ready' || !callable || busy) return
    handled.current = asked.seq
    settle?.(asked.seq)
    setShowHistory(false)
    void ask([...current.messages, { role: 'user', text: asked.text }], asked.excerpt ? { excerpt: asked.excerpt } : {})
  }, [asked, settle, ai.status, callable, busy, current.messages, ask])

  const send = (text: string) => {
    const q = text.trim()
    if (q === '' || busy || !callable) return
    setDraft('')
    if (input.current) input.current.style.height = ''
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

  // Stopped, the button goes: the focus stays in the panel, on the question box, never back to the page's top.
  const stop = () => {
    abort.current?.abort()
    input.current?.focus()
  }

  const startNew = () => {
    abort.current?.abort()
    setError(null)
    setUnread(null)
    setShowHistory(false)
    setCurrent({ id: rt.rng.id(), messages: [], ...(courseId ? { courseId } : {}) })
    input.current?.focus()
  }

  const retry = () => {
    const history = current.messages
    if (history.at(-1)?.role === 'user') void ask(history)
  }

  // Below 1000px the sheet covers the page: following a citation or a link closes it. Docked and expanded, the
  // page is out of sight: the link gives it back its room, for this opening only (not a choice to remember).
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = body.current
    if (!el || (docked && !chat?.expanded)) return
    const onClick = (e: Event) => {
      if (!(e.target instanceof Element && e.target.closest('a'))) return
      if (docked) chat?.showPage()
      else onClose()
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  })

  const chip = chipLabel(t, ws, screen)
  // Suggestions to start a thread on what is on screen (a quiz question: help to approach it, without its answer).
  // Right above the composer, within a thumb's reach: one line that scrolls sideways on phones (faded where more
  // is hidden).
  const actions = actionsFor(t, context, { empty: current.messages.length === 0 && !busy })
  const actionRow = actions.length > 0 && (
    <ul
      ref={actionList}
      className={styles.actionRow}
      aria-label={t('chat.actions')}
      data-more={actionsMore || undefined}
      onScroll={measureActions}
    >
      {actions.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            className={styles.suggestion}
            disabled={!callable || busy}
            onClick={() => void ask([...current.messages, { role: 'user', text: a.label }], { intent: a.intent })}
          >
            {a.label}
          </button>
        </li>
      ))}
    </ul>
  )
  const card = context.card

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

  const tools = (
    <>
      <IconButton
        icon={History}
        label={t('chat.history')}
        aria-pressed={showHistory}
        onClick={() => setShowHistory((s) => !s)}
      />
      <IconButton icon={SquarePen} label={t('chat.newChat')} onClick={startNew} />
    </>
  )
  // Docked, the panel carries its own title. Full screen, one compact row: close, the context
  // (or the list's name), then the tools.
  const toolbar = docked ? (
    <div className={styles.toolbar}>
      <h2 className={styles.title}>{t('chat.title')}</h2>
      <div className={styles.tools}>
        {tools}
        <IconButton
          icon={chat?.expanded ? Minimize2 : Maximize2}
          label={t(chat?.expanded ? 'chat.restore' : 'chat.expand')}
          onClick={chat?.toggleExpanded}
        />
        <IconButton icon={X} label={t('chat.closePanel')} onClick={onClose} className={styles.close} />
      </div>
    </div>
  ) : (
    <div className={cx(styles.toolbar, styles.compact)}>
      <IconButton icon={X} label={t('chat.closePanel')} onClick={onClose} className={styles.close} />
      <div className={styles.context}>
        {showHistory ? (
          <span className={styles.heading}>{t('chat.history')}</span>
        ) : (
          ai.status === 'ready' && contextChip
        )}
      </div>
      <div className={styles.tools}>{tools}</div>
    </div>
  )

  if (ai.status === 'loading') return <div className={styles.body}>{toolbar}</div>
  // The panel only mounts once a model is ready (ChatSlot); this covers the moment a model goes away while it is open.
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
    <div ref={body} className={cx(styles.body, !docked && styles.covering)}>
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
              </div>
            )}
            {keyed(
              current.messages.map((m, at) => ({ m, before: current.messages[at - 1] })),
              // A structured answer keeps its id while it changes (a card saved, a quiz answered).
              ({ m }) => m.id ?? `${m.role}:${m.text}`,
            ).map(({ item: { m, before }, key }) => {
              const rich = m.rich
              if (!rich) {
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
              return (
                <div key={key} className={styles.answer}>
                  <span className="sr-only">{t('chat.tutor')}: </span>
                  <LegacyAnswer rich={rich} card={screen.card} chunks={courseChunks} courseId={current.courseId} />
                </div>
              )
            })}
            {live && (
              <Answer segments={parseCitations(live.text, live.chunks).segments} card={card} streaming>
                {live.text === '' && (
                  <p className={styles.muted} role="status">
                    {t('chat.writing')}
                  </p>
                )}
              </Answer>
            )}
            {!busy && unread?.id === current.id && unread.photoIds[0] && (
              <p className={styles.note}>
                {t('chat.photosUnread', { count: unread.photoIds.length })}{' '}
                <Link href={to.photo(unread.photoIds[0])}>{t('chat.readPhoto')}</Link>
              </p>
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
          {actionRow}
          {!callable && <p className={styles.note}>{t('chat.offline')}</p>}
          <form className={styles.composer} onSubmit={submit}>
            <label className="sr-only" htmlFor={`${current.id}-q`}>
              {t('chat.inputLabel')}
            </label>
            <textarea
              id={`${current.id}-q`}
              ref={input}
              className={styles.input}
              rows={1}
              value={draft}
              placeholder={t('chat.placeholder')}
              disabled={!callable}
              enterKeyHint="send"
              onChange={(e) => {
                setDraft(e.target.value)
                grow(e.currentTarget)
              }}
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

/** Focuses an answer as it arrives (VoiceOver reads it from there), once. */
const _focusOnce = (done: (id: null) => void) => (el: HTMLDivElement | null) => {
  if (!el) return
  el.focus({ preventScroll: true })
  done(null)
}

/** The question box grows with what is typed, up to its maximum height, then scrolls. */
function grow(el: HTMLTextAreaElement): void {
  el.style.height = ''
  el.style.height = `${el.scrollHeight}px`
}

function chipLabel(t: ReturnType<typeof useT>, ws: ModelWorkspace, c: ScreenContext): string {
  if (c.card) return t('chat.aboutCard')
  if (c.question) return t('chat.aboutQuestion')
  if (c.photoId) return t('chat.aboutPhoto')
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
      <>
        {message.photoId && <AttachedPhoto photoId={message.photoId} />}
        <div className={styles.user}>
          <span className="sr-only">{t('chat.you')}: </span>
          {message.text}
        </div>
      </>
    )
  }
  const segments = parseCitations(message.text).segments
  return (
    <Answer segments={segments} card={card}>
      <AnswerActions segments={segments} question={question} courseId={courseId} sectionId={sectionId} card={card} />
    </Answer>
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

  // Suggested, never added on its own: it waits in « Suggested cards » with the others.
  const makeCard = () => {
    if (!courseId) return
    const [id] = ws.drafts.propose([
      {
        courseId,
        ...(sectionId ? { sectionId } : {}),
        unit: 0,
        kind: 'basic',
        type: 'qa',
        front: question?.trim() || text.split('\n')[0] || text,
        back: text,
      },
    ])
    setMade(id ?? null)
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
          {t('chat.cardSuggested')} <Link href={paths.inbox}>{t('chat.openSuggested')}</Link>
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
