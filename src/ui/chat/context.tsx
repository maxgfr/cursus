import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import { useAiReady } from '../ai/ready.ts'

/** What a screen shows, for the chat beside it. Ids only: the panel reads titles and passages itself. */
export interface ScreenContext {
  courseId?: string
  sectionId?: string
  sourceId?: string
  /** A photo on screen (a source of the course). */
  photoId?: string
  /** The card on screen, its faces as shown; before `revealed`, the chat never gives its answer. */
  card?: { front: string; back: string; revealed: boolean }
  /** The id of the card on screen: the chat reads its section's other cards around it. */
  cardId?: string
  /** The review screen: the card's own help sits below it, so the chat suggests nothing on top. */
  review?: true
  /** A quiz question being answered. */
  question?: string
}

/** A question to ask as soon as the chat can: a term selected on screen, with the passage it was read in. */
export interface ChatAsk {
  text: string
  excerpt?: string
  seq: number
}

export interface ChatSnapshot {
  open: boolean
  /** The most specific context the screens on display publish. */
  context: ScreenContext
  asked: ChatAsk | null
  /** Docked, the chat takes the page's whole room instead of its column: so on every opening, until restored. */
  expanded: boolean
}

/** How specific a context is: a card or question beats a source, a section, then a course. */
function rank(c: ScreenContext): number {
  if (c.card || c.question) return 4
  if (c.sourceId || c.photoId) return 3
  if (c.sectionId) return 2
  if (c.courseId) return 1
  return 0
}

class ChatHub {
  private readonly entries = new Map<string, ScreenContext>()
  private readonly listeners = new Set<() => void>()
  private seq = 0
  snapshot: ChatSnapshot = { open: false, context: {}, asked: null, expanded: false }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private emit(next: Partial<ChatSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next }
    for (const l of this.listeners) l()
  }

  private merged(): ScreenContext {
    // Screens nest (a course, then a card in it): every level contributes, the most specific wins.
    const sorted = [...this.entries.values()].sort((a, b) => rank(a) - rank(b))
    return Object.assign({}, ...sorted)
  }

  publish(id: string, context: ScreenContext | null) {
    if (context === null) this.entries.delete(id)
    else this.entries.set(id, context)
    this.emit({ context: this.merged() })
  }

  /** Each opening starts expanded; « Restore » gives the page its column back for that opening only. */
  setOpen(open: boolean) {
    if (open !== this.snapshot.open) this.emit(open ? { open, expanded: true } : { open })
  }

  setExpanded(expanded: boolean) {
    if (expanded !== this.snapshot.expanded) this.emit({ expanded })
  }

  ask(text: string, excerpt?: string) {
    this.seq += 1
    this.emit({
      open: true,
      ...(this.snapshot.open ? {} : { expanded: true }),
      asked: { text, ...(excerpt ? { excerpt } : {}), seq: this.seq },
    })
  }

  /**
   * The question numbered `seq` was sent: it is forgotten, so a chat mounted again later (the model set up again
   * after it was removed) never sends it a second time.
   */
  settle(seq: number) {
    if (this.snapshot.asked?.seq === seq) this.emit({ asked: null })
  }

  /** The model went away: the chat closes and nothing waiting is sent once one is back. */
  drop() {
    if (this.snapshot.open || this.snapshot.asked) this.emit({ open: false, asked: null })
  }
}

const Hub = createContext<ChatHub | null>(null)

export interface ChatApi extends ChatSnapshot {
  toggle(): void
  close(): void
  /** Docked, takes the page's whole room, or gives it back (the column at its chosen width). */
  toggleExpanded(): void
  /**
   * Opens the chat and asks `text` there, `excerpt` going along as context: a term selected on screen (with the
   * passage it was read in), or what a feature answered, to go on about it (« Continue in the chat »).
   */
  ask(text: string, excerpt?: string): void
  /** The question numbered `seq` was sent by the chat: it is never sent again. */
  settle(seq: number): void
}

const NO_SNAPSHOT: ChatSnapshot = { open: false, context: {}, asked: null, expanded: false }
const noop = () => () => {}

/** The chat beside the screens; null outside the app's shell (boot failure). */
export function useChat(): ChatApi | null {
  const hub = useContext(Hub)
  const snap = useSyncExternalStore(hub?.subscribe ?? noop, () => hub?.snapshot ?? NO_SNAPSHOT)
  return useMemo(
    () =>
      hub && {
        ...snap,
        toggle: () => hub.setOpen(!hub.snapshot.open),
        close: () => hub.setOpen(false),
        toggleExpanded: () => hub.setExpanded(!hub.snapshot.expanded),
        ask: (text: string, excerpt?: string) => hub.ask(text, excerpt),
        settle: (seq: number) => hub.settle(seq),
      },
    [hub, snap],
  )
}

/**
 * Tells the chat what this screen shows, for as long as it is mounted; on unmount the context falls back to
 * what the screens around it publish.
 */
export function useChatContext(context: ScreenContext): void {
  const hub = useContext(Hub)
  const id = useId()
  const key = JSON.stringify(context)
  useEffect(() => {
    if (!hub) return
    hub.publish(id, JSON.parse(key) as ScreenContext)
    return () => hub.publish(id, null)
  }, [hub, id, key])
}

export const isChatKey = (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j'

/**
 * Holds the chat's state for the whole app; ⌘J / Ctrl+J opens and closes it once a model is ready. Without one
 * the shortcut is left to the browser, and a chat left open (the model was just removed) closes, forgetting what
 * was waiting to run.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const hub = useMemo(() => new ChatHub(), [])
  const ready = useAiReady()
  const readyNow = useRef(ready)
  readyNow.current = ready
  useEffect(() => {
    if (!ready) hub.drop()
  }, [hub, ready])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isChatKey(e) || !readyNow.current) return
      e.preventDefault()
      hub.setOpen(!hub.snapshot.open)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [hub])
  return <Hub.Provider value={hub}>{children}</Hub.Provider>
}
