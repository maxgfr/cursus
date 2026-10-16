import { ExternalLink, Minus, Plus, Unlink } from 'lucide-react'
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../components/Button.tsx'
import { Field } from '../components/Field.tsx'
import { Sanitized } from '../render/Sanitized.tsx'
import { mathMarkdown } from './format.ts'
import styles from './MarkdownEditor.module.css'

/** Where the popover points: the edited element's box on screen. */
export interface Anchor {
  left: number
  top: number
  bottom: number
}

const MARGIN = 8

/**
 * A small dialog next to what it edits (a link, a formula, a table): not modal, closed by Escape or a press
 * outside. The focus goes into it (unless `focus` is false: a link tapped in the text shows its card while the
 * text keeps the focus), and back to the text when it closes.
 */
function Popover({
  anchor,
  label,
  focus = true,
  onClose,
  children,
}: {
  anchor: Anchor
  label: string
  focus?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const close = useRef(onClose)
  close.current = onClose

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const below = anchor.bottom + MARGIN
    const top = below + height <= innerHeight - MARGIN ? below : Math.max(MARGIN, anchor.top - MARGIN - height)
    const left = Math.min(Math.max(MARGIN, anchor.left), Math.max(MARGIN, innerWidth - width - MARGIN))
    setPlace({ left, top })
  }, [anchor])

  const focusFirst = useRef(focus)
  useEffect(() => {
    if (focusFirst.current) box.current?.querySelector<HTMLElement>('input, textarea, a, button')?.focus()
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) close.current()
    }
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close.current()
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', onEscape, true)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', onEscape, true)
    }
  }, [])

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label={label}
      className={styles.popover}
      style={place ? { left: place.left, top: place.top } : { left: anchor.left, top: anchor.bottom, opacity: 0 }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** A link's editor: open it, change its address (and its text, for a new one), or take the link off. */
export function LinkPopover({
  anchor,
  url,
  text,
  focus,
  onApply,
  onRemove,
  onClose,
}: {
  anchor: Anchor
  url: string
  /** The text of a new link (null: an existing link keeps its own). */
  text: string | null
  /** Whether it takes the focus (from the toolbar or Mod-K) or leaves it in the text (a tap on the link). */
  focus: boolean
  onApply: (url: string, text: string) => void
  onRemove: (() => void) | null
  onClose: () => void
}) {
  const t = useT()
  const [address, setAddress] = useState(url)
  const [label, setLabel] = useState(text ?? '')
  const apply = () => {
    const next = address.trim()
    if (next === '') return
    onApply(next, text === null ? '' : label.trim() || next)
  }
  return (
    <Popover anchor={anchor} label={t('common.edLink')} focus={focus} onClose={onClose}>
      {url !== '' && (
        <a className={styles.openLink} href={url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} aria-hidden="true" /> {t('common.edLinkOpen')}
        </a>
      )}
      <form
        className={styles.popoverForm}
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
      >
        {text !== null && (
          <Field label={t('common.edLinkText')} value={label} onChange={(e) => setLabel(e.target.value)} />
        )}
        <Field
          label={t('common.edLinkAddress')}
          type="url"
          inputMode="url"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <div className={styles.popoverActions}>
          {onRemove && (
            <Button variant="plain" onClick={onRemove}>
              <Unlink size={16} aria-hidden="true" />
              {t('common.edLinkRemove')}
            </Button>
          )}
          <Button variant="plain" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={address.trim() === ''}>
            {t('common.edApply')}
          </Button>
        </div>
      </form>
    </Popover>
  )
}

/** A formula's editor: its LaTeX, drawn as it is typed. */
export function MathPopover({
  anchor,
  latex,
  block,
  onApply,
  onClose,
}: {
  anchor: Anchor
  latex: string
  block: boolean
  onApply: (latex: string) => void
  onClose: () => void
}) {
  const t = useT()
  const [source, setSource] = useState(latex)
  const id = useId()
  return (
    <Popover anchor={anchor} label={t('common.edMath')} onClose={onClose}>
      <label className={styles.caption} htmlFor={id}>
        {t('common.edMathSource')}
      </label>
      <textarea
        id={id}
        className={styles.latex}
        value={source}
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => setSource(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && source.trim() !== '') {
            e.preventDefault()
            onApply(source)
          }
        }}
      />
      <p className={styles.caption}>{t('common.edMathPreview')}</p>
      <div className={styles.preview}>
        {source.trim() !== '' && <Sanitized markdown={mathMarkdown(source, block)} />}
      </div>
      <div className={styles.popoverActions}>
        <Button variant="plain" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={source.trim() === ''} onClick={() => onApply(source)}>
          {t('common.edApply')}
        </Button>
      </div>
    </Popover>
  )
}

/** A table's editor: its cells as a grid (the first row is the header), rows and columns added or taken off. */
export function TablePopover({
  anchor,
  rows: initial,
  onApply,
  onClose,
}: {
  anchor: Anchor
  rows: string[][]
  onApply: (rows: string[][]) => void
  onClose: () => void
}) {
  const t = useT()
  // Rows and columns keep an id each, so an input keeps its focus while the grid grows or shrinks.
  const next = useRef(0)
  const fresh = () => next.current++
  const [grid, setGrid] = useState(() => ({
    rows: initial.map((cells) => ({ id: fresh(), cells })),
    cols: (initial[0] ?? ['']).map(() => fresh()),
  }))
  const width = grid.cols.length
  const set = (r: number, c: number, value: string) =>
    setGrid((g) => ({
      ...g,
      rows: g.rows.map((row, i) => (i === r ? { ...row, cells: row.cells.map((x, k) => (k === c ? value : x)) } : row)),
    }))
  return (
    <Popover anchor={anchor} label={t('common.edTable')} onClose={onClose}>
      <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${width}, minmax(6rem, 1fr))` }}>
        {grid.rows.map((row, r) =>
          grid.cols.map((col, c) => (
            <input
              key={`${row.id}-${col}`}
              className={r === 0 ? styles.head : undefined}
              aria-label={t('common.edTableCell', { row: r + 1, column: c + 1 })}
              value={row.cells[c] ?? ''}
              onChange={(e) => set(r, c, e.target.value)}
            />
          )),
        )}
      </div>
      <div className={styles.popoverActions}>
        <Button
          variant="plain"
          onClick={() => setGrid((g) => ({ ...g, rows: [...g.rows, { id: fresh(), cells: g.cols.map(() => '') }] }))}
        >
          <Plus size={16} aria-hidden="true" />
          {t('common.edTableAddRow')}
        </Button>
        <Button
          variant="plain"
          onClick={() =>
            setGrid((g) => ({
              cols: [...g.cols, fresh()],
              rows: g.rows.map((row, i) => ({
                ...row,
                cells: [...row.cells, i === 0 ? t('common.edTableColumn', { n: g.cols.length + 1 }) : ''],
              })),
            }))
          }
        >
          <Plus size={16} aria-hidden="true" />
          {t('common.edTableAddColumn')}
        </Button>
        <Button
          variant="plain"
          disabled={grid.rows.length <= 2}
          onClick={() => setGrid((g) => ({ ...g, rows: g.rows.slice(0, -1) }))}
        >
          <Minus size={16} aria-hidden="true" />
          {t('common.edTableRemoveRow')}
        </Button>
        <Button
          variant="plain"
          disabled={width <= 1}
          onClick={() =>
            setGrid((g) => ({
              cols: g.cols.slice(0, -1),
              rows: g.rows.map((row) => ({ ...row, cells: row.cells.slice(0, -1) })),
            }))
          }
        >
          <Minus size={16} aria-hidden="true" />
          {t('common.edTableRemoveColumn')}
        </Button>
      </div>
      <div className={styles.popoverActions}>
        <Button variant="plain" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={() => onApply(grid.rows.map((row) => row.cells))}>
          {t('common.edApply')}
        </Button>
      </div>
    </Popover>
  )
}
