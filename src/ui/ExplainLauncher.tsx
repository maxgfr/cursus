import { MessageCircle } from 'lucide-react'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/react.tsx'
import type { AiModelState } from '../screens/Understand/shared/aiConfig.ts'
import { useChat } from './chat/context.tsx'
import { Button } from './components/Button.tsx'
import styles from './ExplainLauncher.module.css'

/** Whether the browser says it is online, kept current. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

/**
 * Whether the model can be called now: online, or a model that runs on this device (it needs no
 * connection). Every AI entry point gates on this, never on the connection alone.
 */
export function useCanCallAi(ai: AiModelState): boolean {
  const online = useOnline()
  return online || (ai.status === 'ready' && ai.runsOffline)
}

/** A selection longer than this is a passage, asked about as a whole; any length is accepted up to the cap. */
const TERM_CHARS = 60
const TERM_WORDS = 6
const MAX_SELECTION_CHARS = 4000
const BLOCK = 'p, li, dt, dd, td, th, blockquote, h1, h2, h3, h4, h5, h6, .cm-line'

export interface SelectedTerm {
  term: string
  /** The paragraph or line it was selected in. */
  context: string
  /** More than a term: a passage, asked about as a whole. */
  passage: boolean
}

/** What « Ask about » shows and sends for a selection: a term in its line, or a whole passage. */
export function askAbout(
  t: ReturnType<typeof useT>,
  selected: SelectedTerm,
): { label: string; question: string; excerpt: string } {
  if (!selected.passage) {
    return {
      label: t('chat.askTerm', { term: selected.term }),
      question: t('chat.termQuestion', { term: selected.term }),
      excerpt: selected.context,
    }
  }
  return { label: t('chat.askPassage'), question: t('chat.passageQuestion'), excerpt: selected.term }
}

const elementOf = (node: Node): Element | null => (node instanceof Element ? node : node.parentElement)

/**
 * The term currently selected inside an element `scopeOf` accepts (it returns that element, or null).
 * The launcher's own controls hold the term: pressing or focusing them may collapse the selection first
 * (a tap on iPhone, Tab from the editor), and the term must survive until they act on it.
 */
export function useSelectedTerm(scopeOf: (el: Element) => Element | null): {
  selected: SelectedTerm | null
  launcher: RefObject<HTMLDivElement | null>
  clear: () => void
} {
  const [selected, setSelected] = useState<SelectedTerm | null>(null)
  const launcher = useRef<HTMLDivElement>(null)
  const pressed = useRef(false)
  const scope = useRef(scopeOf)
  scope.current = scopeOf

  useEffect(() => {
    const held = () => pressed.current || (launcher.current?.contains(document.activeElement) ?? false)
    const onPress = (e: PointerEvent) => {
      pressed.current = e.target instanceof Node && (launcher.current?.contains(e.target) ?? false)
    }
    const onChange = () => {
      const sel = document.getSelection()
      const term = sel?.toString().replace(/\s+/g, ' ').trim() ?? ''
      const node = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0).commonAncestorContainer : null
      const el = node ? elementOf(node) : null
      // Text in a sheet (or any dialog) is not the screen's.
      const within = el && el.closest('dialog') === null ? scope.current(el) : null
      if (within === null || term === '') {
        if (!held()) setSelected(null)
        return
      }
      const kept = term.length > MAX_SELECTION_CHARS ? `${term.slice(0, MAX_SELECTION_CHARS - 1)}…` : term
      const passage = kept.length > TERM_CHARS || kept.split(' ').length > TERM_WORDS
      const block = el?.closest(BLOCK) ?? within
      const context = (within.contains(block) ? block : within).textContent?.trim() ?? ''
      setSelected((prev) => (prev?.term === kept && prev.context === context ? prev : { term: kept, context, passage }))
    }
    document.addEventListener('pointerdown', onPress, true)
    document.addEventListener('selectionchange', onChange)
    return () => {
      document.removeEventListener('pointerdown', onPress, true)
      document.removeEventListener('selectionchange', onChange)
    }
  }, [])

  const clear = useCallback(() => {
    pressed.current = false
    setSelected(null)
  }, [])
  return { selected, launcher, clear }
}

/** Keeps the selection (and the editor's focus) when a mouse presses a launcher control. */
export const keepSelection = (e: { button: number; preventDefault: () => void }) => {
  if (e.button === 0) e.preventDefault()
}

export interface AskSelectionProps {
  /** Selector of the element whose text can be asked about; the screen's main content by default. */
  within?: string
}

/**
 * « Ask about “term” » for text selected in a reader (a source, an explanation): a button pinned above the tab
 * bar and the keyboard while a short selection lasts. It opens the chat on the term, with the passage it was
 * selected in and what the screen shows; the chat says how to set up AI when no model is ready.
 */
export function AskSelection({ within = 'main' }: AskSelectionProps) {
  const t = useT()
  const chat = useChat()
  const scopeOf = useCallback((el: Element) => el.closest(within), [within])
  const { selected, launcher, clear } = useSelectedTerm(scopeOf)
  if (!chat || !selected) return null
  const ask = () => {
    const { question, excerpt } = askAbout(t, selected)
    chat.ask(question, excerpt)
    clear()
  }
  return (
    <div ref={launcher} className={styles.region}>
      <div className={styles.bar}>
        <Button
          variant="primary"
          icon={<MessageCircle size={18} strokeWidth={1.75} aria-hidden />}
          onMouseDown={keepSelection}
          onClick={ask}
        >
          {askAbout(t, selected).label}
        </Button>
      </div>
    </div>
  )
}
