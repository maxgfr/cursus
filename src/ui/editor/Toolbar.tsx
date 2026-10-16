import {
  Bold,
  Code,
  Ellipsis,
  EyeOff,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  type LucideIcon,
  Quote,
  Redo2,
  Sigma,
  Strikethrough,
  Table,
  Undo2,
} from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useT } from '../../i18n/react.tsx'
import { isApple } from '../chat/ChatButton.tsx'
import { Button as TextButton } from '../components/Button.tsx'
import { IconButton } from '../components/IconButton.tsx'
import type { Format } from './format.ts'
import styles from './MarkdownEditor.module.css'

export type { Format } from './format.ts'

type Label =
  | 'common.edBold'
  | 'common.edItalic'
  | 'common.edStrike'
  | 'common.edCode'
  | 'common.edLink'
  | 'common.edMath'
  | 'common.edH1'
  | 'common.edH2'
  | 'common.edH3'
  | 'common.edList'
  | 'common.edNumbered'
  | 'common.edChecklist'
  | 'common.edQuote'
  | 'common.edTable'

type Button = readonly [Format, LucideIcon, Label, string?]

/** The toolbar's buttons, in groups: inline styles, blocks, then what is inserted. */
const GROUPS: readonly (readonly Button[])[] = [
  [
    ['bold', Bold, 'common.edBold', 'Mod-B'],
    ['italic', Italic, 'common.edItalic', 'Mod-I'],
    ['strike', Strikethrough, 'common.edStrike'],
    ['code', Code, 'common.edCode'],
    ['link', Link, 'common.edLink', 'Mod-K'],
    ['math', Sigma, 'common.edMath'],
  ],
  [
    ['h1', Heading1, 'common.edH1'],
    ['h2', Heading2, 'common.edH2'],
    ['h3', Heading3, 'common.edH3'],
    ['bullet', List, 'common.edList', 'Mod-Shift-8'],
    ['numbered', ListOrdered, 'common.edNumbered', 'Mod-Shift-7'],
    ['task', ListChecks, 'common.edChecklist', 'Mod-Shift-9'],
    ['quote', Quote, 'common.edQuote'],
  ],
  [['table', Table, 'common.edTable']],
]

/** A CodeMirror key name as ARIA writes it (`Mod` is Meta on Apple devices, Control elsewhere; `+` between keys). */
function ariaKeys(key: string, apple: boolean): string {
  return key.replace('Mod', apple ? 'Meta' : 'Control').replaceAll('-', '+')
}

export interface ToolbarProps {
  /** The raw Markdown is shown instead of the text as it reads. */
  source: boolean
  /** The editor offers to add a photo (it knows where photos go). */
  photo?: boolean
  /** The text is a cloze card's: its first button hides the selection as a blank. */
  cloze?: boolean
  /**
   * The editor's controls; all absent while its code loads. The toolbar then holds the very place it will take
   * (same controls, same wrapping), so nothing below it moves when the editor arrives under a tap.
   */
  live?: {
    onSource: (source: boolean) => void
    onFormat: (format: Format) => void
    onPhoto: () => void
    /** The formats in effect where the caret is. */
    active: ReadonlySet<Format>
    /** Undo and Redo, following the editor's history. */
    history: ReactNode
  }
}

/** The formatting toolbar of the Markdown editor, live or as the loading placeholder. */
export function Toolbar({ source, photo = false, cloze = false, live }: ToolbarProps) {
  const t = useT()
  const idle = live === undefined
  const apple = isApple()
  return (
    <div
      className={styles.toolbar}
      role="toolbar"
      aria-label={t('common.edFormatting')}
      aria-hidden={idle || undefined}
      inert={idle}
    >
      <div className={styles.formats}>
        {cloze && (
          <div className={styles.group}>
            <TextButton
              variant="plain"
              icon={<EyeOff size={18} aria-hidden="true" />}
              disabled={idle || source}
              aria-pressed={live?.active.has('cloze') ?? false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => live?.onFormat('cloze')}
            >
              {t('common.edCloze')}
            </TextButton>
            <span className={styles.divider} aria-hidden="true" />
          </div>
        )}
        {GROUPS.map((group, i) => (
          <div key={group[0]?.[0]} className={styles.group}>
            {i > 0 && <span className={styles.divider} aria-hidden="true" />}
            {group.map(([format, icon, label, keys]) => (
              <IconButton
                key={format}
                icon={icon}
                label={t(label)}
                disabled={idle || source}
                aria-pressed={live?.active.has(format) ?? false}
                aria-keyshortcuts={keys ? ariaKeys(keys, apple) : undefined}
                // The editor keeps the focus and its selection: the format applies where the caret is.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => live?.onFormat(format)}
              />
            ))}
            {i === GROUPS.length - 1 && photo && (
              <IconButton
                icon={ImagePlus}
                label={t('common.edPhoto')}
                disabled={idle || source}
                onClick={() => live?.onPhoto()}
              />
            )}
          </div>
        ))}
      </div>
      <span className={styles.spacer} />
      <More source={source} idle={idle} onSource={(next) => live?.onSource(next)} />
      <span className={styles.divider} aria-hidden="true" />
      {live ? (
        live.history
      ) : (
        <div className={styles.group}>
          <IconButton icon={Undo2} label={t('common.undo')} disabled />
          <IconButton icon={Redo2} label={t('common.redo')} disabled />
        </div>
      )}
    </div>
  )
}

/** « More options »: the switch that shows the Markdown, for those who write it. */
function More({ source, idle, onSource }: { source: boolean; idle: boolean; onSource: (source: boolean) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const panel = useId()
  const box = useRef<HTMLDivElement>(null)
  // A press elsewhere closes it; Escape closes it and gives the focus back to its button.
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !box.current?.contains(document.activeElement)) return
      e.stopPropagation()
      setOpen(false)
      box.current.querySelector('button')?.focus()
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', onEscape, true)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', onEscape, true)
    }
  }, [open])
  return (
    <div ref={box} className={styles.more}>
      <IconButton
        icon={Ellipsis}
        label={t('common.edMore')}
        disabled={idle}
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div id={panel} className={styles.menu}>
          <label className={styles.switch}>
            <input
              type="checkbox"
              role="switch"
              aria-checked={source}
              checked={source}
              onChange={(e) => {
                onSource(e.target.checked)
                setOpen(false)
              }}
            />
            {t('common.edSourceLabel')}
          </label>
        </div>
      )}
    </div>
  )
}
