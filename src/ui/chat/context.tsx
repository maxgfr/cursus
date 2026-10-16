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
import type { StudyOptions } from '../../core/ai/features/tutorChat'
import { useAiReady } from '../ai/ready.ts'
import type { ChatActionId } from './actions.ts'

/** What a screen shows, for the chat beside it. Ids only: the panel reads titles and passages itself. */
export interface ScreenContext {
  courseId?: string
  sectionId?: string
  sourceId?: string
  /** A photo on screen (a source of the course). */
  photoId?: string
  /**
   * The card on screen; before `revealed`, the chat never gives its answer. `id` lets the chat rewrite it
   * (« Improve »); the faces are as shown.
   */
  card?: { front: string; back: string; revealed: boolean; id?: string }
  /** A quiz question being answered. */
  question?: string
}

/** An action of the panel to run as soon as the chat can (« Explain the question » from review, say). */
export interface ChatRun {
  id: ChatActionId
  seq: number
  /**
   * Where it runs: the chat waits for the screens to show this course (and section) before running it, so a
   * route that opens a course and runs an action at once finds the course's context.
   */
  scope?: { courseId: string; sectionId?: string }
  /** What a study action runs with, over what it would start from on that screen (« Quiz me » set up first). */
  options?: Partial<StudyOptions>
}

/** A grade the chat suggested for an answer in the student's own words, for the card on screen to offer. */
export interface ChatGrade {
  card: { front: string; back: string }
  rating: 1 | 2 | 3 | 4
  feedback: string
  seq: number
}

/** A grade given in the chat to the card on screen (confirming, or changing, the one it suggested). */
export interface ChatRating {
  card: { front: string; back: string }
  rating: 1 | 2 | 3 | 4
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
  running: ChatRun | null
  asked: ChatAsk | null
  graded: ChatGrade | null
  rated: ChatRating | null
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
  snapshot: ChatSnapshot = { open: false, context: {}, running: null, asked: null, graded: null, rated: null }

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

  runAction(id: ChatActionId, scope?: ChatRun['scope'], options?: ChatRun['options']) {
    this.seq += 1
    this.emit({
      open: true,
      running: { id, seq: this.seq, ...(scope ? { scope } : {}), ...(options ? { options } : {}) },
    })
  }

  grade(grade: Omit<ChatGrade, 'seq'>) {
    this.seq += 1
    this.emit({ graded: { ...grade, seq: this.seq } })
  }

  rate(rating: Omit<ChatRating, 'seq'>) {
    this.seq += 1
    this.emit({ rated: { ...rating, seq: this.seq } })
  }

  ask(text: string, excerpt?: string) {
    this.seq += 1
    this.emit({ open: true, asked: { text, ...(excerpt ? { excerpt } : {}), seq: this.seq } })
  }

  /**
   * The run or question numbered `seq` was carried out: it is forgotten, so a chat mounted again later (the model
   * set up again after it was removed) never sends it a second time.
   */
  settle(seq: number) {
    const next: Partial<ChatSnapshot> = {}
    if (this.snapshot.running?.seq === seq) next.running = null
    if (this.snapshot.asked?.seq === seq) next.asked = null
    if ('running' in next || 'asked' in next) this.emit(next)
  }

  /** The model went away: the chat closes and nothing waiting to run is sent once one is back. */
  drop() {
    if (this.snapshot.open || this.snapshot.running || this.snapshot.asked) {
      this.emit({ open: false, running: null, asked: null })
    }
  }
}

const Hub = createContext<ChatHub | null>(null)

export interface ChatApi extends ChatSnapshot {
  toggle(): void
  close(): void
  /**
   * Opens the chat and runs one of its actions for the screen (see `actionById`), once the screens show `scope`
   * when one is given; a study action runs with `options` over what it would start from.
   */
  run(id: ChatActionId, scope?: ChatRun['scope'], options?: ChatRun['options']): void
  /** Opens the chat and asks `text` there, `excerpt` (what it was selected in) going along as context. */
  ask(text: string, excerpt?: string): void
  /** Hands a grade suggested in the chat to the card on screen. */
  grade(grade: Omit<ChatGrade, 'seq'>): void
  /** Grades the card on screen from the chat. */
  rate(rating: Omit<ChatRating, 'seq'>): void
  /** The run or question numbered `seq` was carried out by the chat: it is never carried out again. */
  settle(seq: number): void
}

const NO_SNAPSHOT: ChatSnapshot = { open: false, context: {}, running: null, asked: null, graded: null, rated: null }
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
        run: (id: ChatActionId, scope?: ChatRun['scope'], options?: ChatRun['options']) =>
          hub.runAction(id, scope, options),
        ask: (text: string, excerpt?: string) => hub.ask(text, excerpt),
        grade: (grade: Omit<ChatGrade, 'seq'>) => hub.grade(grade),
        rate: (rating: Omit<ChatRating, 'seq'>) => hub.rate(rating),
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
