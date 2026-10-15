import { BookOpen } from 'lucide-react'
import { type RefObject, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'
import { lazyChunk } from '../app/lazyChunk.tsx'
import { paths } from '../app/routes.ts'
import { useT } from '../i18n/react.tsx'
import { type AiModelState, useAiModel } from '../screens/Understand/shared/aiConfig.ts'
import { Button, buttonClass } from './components/Button.tsx'
import styles from './ExplainLauncher.module.css'
import type { ExplainRequest, ExplainSheetProps, ExplainTarget } from './ExplainSheet.tsx'

/** The explanation sheet, loaded the first time something asks for an explanation. */
export const LazyExplainSheet = lazyChunk<ExplainSheetProps>('explainSheet', () => import('./ExplainSheet.tsx'))

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

/** A short selection: a term or an expression, not a passage. */
const MAX_TERM_CHARS = 80
const MAX_TERM_WORDS = 8
const BLOCK = 'p, li, dt, dd, td, th, blockquote, h1, h2, h3, h4, h5, h6, .cm-line'

export interface SelectedTerm {
  term: string
  /** The paragraph or line it was selected in. */
  context: string
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
      const words = term === '' ? 0 : term.split(' ').length
      if (within === null || term === '' || term.length > MAX_TERM_CHARS || words > MAX_TERM_WORDS) {
        if (!held()) setSelected(null)
        return
      }
      const block = el?.closest(BLOCK) ?? within
      const context = (within.contains(block) ? block : within).textContent?.trim() ?? ''
      setSelected((prev) => (prev?.term === term && prev.context === context ? prev : { term, context }))
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

/** Launch requests for the sheet: each one gets a new `seq`, so the sheet knows it was asked again. */
export function useExplainTarget(): {
  target: ExplainTarget | null
  open: boolean
  launch: (request: ExplainRequest) => void
  close: () => void
} {
  const [target, setTarget] = useState<ExplainTarget | null>(null)
  const [open, setOpen] = useState(false)
  const seq = useRef(0)
  const launch = useCallback((request: ExplainRequest) => {
    seq.current += 1
    setTarget({ ...request, seq: seq.current })
    setOpen(true)
  }, [])
  const close = useCallback(() => setOpen(false), [])
  return { target, open, launch, close }
}

export interface ExplainSelectionProps {
  /** Course the explanation is grounded in, and where a card on the concept goes. */
  courseId?: string
  sectionId?: string
  /** Selector of the element whose text can be explained; the screen's main content by default. */
  within?: string
}

/**
 * "Explain “term”" for text selected in a reader (a source, a fiche): a button pinned above the tab bar
 * and the keyboard while a short selection lasts, opening the explanation sheet. Without a model it is a
 * link to the AI settings; offline it is disabled, saying why, unless the model runs on this device.
 */
export function ExplainSelection({ courseId, sectionId, within = 'main' }: ExplainSelectionProps) {
  const t = useT()
  const ai = useAiModel()
  const callable = useCanCallAi(ai)
  const scopeOf = useCallback((el: Element) => el.closest(within), [within])
  const { selected, launcher, clear } = useSelectedTerm(scopeOf)
  const { target, open, launch, close } = useExplainTarget()

  const explain = () => {
    if (!selected) return
    launch({ kind: 'concept', term: selected.term, context: selected.context })
    clear()
  }

  return (
    <>
      {selected && ai.status !== 'loading' && (
        <div ref={launcher} className={styles.region}>
          <div className={styles.bar}>
            {ai.status === 'missing' ? (
              <Link href={paths.settingsAi} className={buttonClass({ variant: 'secondary' })}>
                {t('ai.explainSetup', { term: selected.term })}
              </Link>
            ) : (
              <Button
                variant="primary"
                icon={<BookOpen size={18} strokeWidth={1.75} aria-hidden />}
                disabled={!callable}
                onMouseDown={keepSelection}
                onClick={explain}
              >
                {t('ai.explainTerm', { term: selected.term })}
              </Button>
            )}
            {!callable && ai.status === 'ready' && <p className={styles.note}>{t('ai.explainOffline')}</p>}
          </div>
        </div>
      )}
      <Sheet ai={ai} target={target} open={open} onClose={close} courseId={courseId} sectionId={sectionId} />
    </>
  )
}

/** The lazy sheet, mounted from the first request on so it keeps its results between openings. */
function Sheet({
  ai,
  target,
  ...rest
}: { ai: AiModelState; target: ExplainTarget | null } & Omit<ExplainSheetProps, 'ai' | 'target'>) {
  if (target === null || ai.status !== 'ready') return null
  return (
    <Suspense fallback={null}>
      <LazyExplainSheet ai={ai} target={target} {...rest} />
    </Suspense>
  )
}

export { Sheet as ExplainSheetSlot }
