import { createContext, type ReactNode, useContext, useEffect, useId, useMemo, useSyncExternalStore } from 'react'

/** What a screen shows, for the chat beside it. Ids only: the panel reads titles and passages itself. */
export interface ScreenContext {
  courseId?: string
  sectionId?: string
  sourceId?: string
  /** The card on screen; before `revealed`, the chat never gives its answer. */
  card?: { front: string; back: string; revealed: boolean }
  /** A quiz question being answered. */
  question?: string
}

/** What the chat opens on: an explanation already shown, to ask a follow-up about. */
export interface ChatSeed {
  text: string
  seq: number
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
  seed: ChatSeed | null
  asked: ChatAsk | null
}

/** How specific a context is: a card or question beats a source, a section, then a course. */
function rank(c: ScreenContext): number {
  if (c.card || c.question) return 4
  if (c.sourceId) return 3
  if (c.sectionId) return 2
  if (c.courseId) return 1
  return 0
}

class ChatHub {
  private readonly entries = new Map<string, ScreenContext>()
  private readonly listeners = new Set<() => void>()
  private seq = 0
  snapshot: ChatSnapshot = { open: false, context: {}, seed: null, asked: null }

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

  setOpen(open: boolean) {
    if (open !== this.snapshot.open) this.emit({ open })
  }

  openWith(text: string) {
    this.seq += 1
    this.emit({ open: true, seed: { text, seq: this.seq } })
  }

  ask(text: string, excerpt?: string) {
    this.seq += 1
    this.emit({ open: true, asked: { text, ...(excerpt ? { excerpt } : {}), seq: this.seq } })
  }
}

const Hub = createContext<ChatHub | null>(null)

export interface ChatApi extends ChatSnapshot {
  toggle(): void
  close(): void
  /** Opens the chat on an explanation, to ask a follow-up. */
  followUp(text: string): void
  /** Opens the chat and asks `text` there, `excerpt` (what it was selected in) going along as context. */
  ask(text: string, excerpt?: string): void
}

const NO_SNAPSHOT: ChatSnapshot = { open: false, context: {}, seed: null, asked: null }
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
        followUp: (text: string) => hub.openWith(text),
        ask: (text: string, excerpt?: string) => hub.ask(text, excerpt),
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

/** Holds the chat's state for the whole app; ⌘J / Ctrl+J opens and closes it. */
export function ChatProvider({ children }: { children: ReactNode }) {
  const hub = useMemo(() => new ChatHub(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isChatKey(e)) return
      e.preventDefault()
      hub.setOpen(!hub.snapshot.open)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [hub])
  return <Hub.Provider value={hub}>{children}</Hub.Provider>
}
