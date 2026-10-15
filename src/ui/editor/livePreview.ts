import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  type EditorState,
  type Extension,
  Prec,
  type Range,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  type MouseSelectionStyle,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import proseStyles from '../render/Sanitized.module.css'
import { fillSanitized } from '../render/Sanitized.tsx'
import { PHOTO, type PlanOptions, planBlocks, planInline, type Span, tableCellOffset, wordNear } from './livePlan.ts'

/** The displayable URLs of the photos the text holds, set from outside once they are loaded. */
export const setPhotoUrls = StateEffect.define<ReadonlyMap<string, string>>()

/** Those URLs, by sha256: kept whatever the view (live or source). */
export const photoUrls = StateField.define<ReadonlyMap<string, string>>({
  create: () => new Map(),
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setPhotoUrls) ? e.value : v), value),
})

/** The photo itself: in place of the line that references it, or under that line (then set off from it). */
class PhotoWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly under: boolean,
  ) {
    super()
  }

  override eq(other: PhotoWidget): boolean {
    return other.url === this.url && other.alt === this.alt && other.under === this.under
  }

  toDOM(): HTMLElement {
    const box = document.createElement('div')
    box.className = this.under ? 'cm-photoPreview cm-photoUnder cm-md-block' : 'cm-photoPreview cm-md-block'
    const img = document.createElement('img')
    img.src = this.url
    img.alt = this.alt
    img.loading = 'lazy'
    img.decoding = 'async'
    box.append(img)
    return box
  }

  override ignoreEvent(): boolean {
    return false
  }
}

/** A formula, drawn by KaTeX through the renderer's own sanitising pipeline. */
class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly block: boolean,
  ) {
    super()
  }

  override eq(other: MathWidget): boolean {
    return other.source === this.source && other.block === this.block
  }

  toDOM(): HTMLElement {
    const host = document.createElement(this.block ? 'div' : 'span')
    host.className = this.block ? 'cm-md-math cm-md-block' : 'cm-md-math'
    fillSanitized(host, this.source, { inline: !this.block })
    return host
  }

  override ignoreEvent(): boolean {
    return false
  }
}

/** A table, drawn by the renderer (sanitised, its photos shown); a tap on a cell puts the caret in that cell. */
class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    /** The URLs of the photos the table holds, by sha256. */
    readonly photos: ReadonlyMap<string, string>,
  ) {
    super()
  }

  override eq(other: TableWidget): boolean {
    if (other.source !== this.source || other.photos.size !== this.photos.size) return false
    for (const [sha, url] of this.photos) if (other.photos.get(sha) !== url) return false
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement('div')
    host.className = 'cm-md-table cm-md-block'
    fillSanitized(host, this.source, { resolveBlob: (sha) => this.photos.get(sha) ?? null })
    host.addEventListener('mousedown', (e) => {
      const cell = cellOf(e.target)
      const row = cell?.parentElement
      if (!cell || !(row instanceof HTMLTableRowElement) || e.button !== 0) return
      e.preventDefault()
      const at = view.posAtDOM(host) + tableCellOffset(this.source, row.rowIndex, cell.cellIndex)
      view.dispatch({ selection: { anchor: at }, userEvent: 'select.pointer' })
      view.focus()
    })
    return host
  }

  /** A cell's own press is handled above; elsewhere the editor places the caret. */
  override ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' && cellOf(event.target) !== null
  }
}

function cellOf(target: EventTarget | null): HTMLTableCellElement | null {
  const cell = target instanceof Element ? target.closest('th, td') : null
  return cell instanceof HTMLTableCellElement ? cell : null
}

const BULLETS = ['disc', 'circle', 'square'] as const

class ListMarkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly depth: number,
  ) {
    super()
  }

  override eq(other: ListMarkWidget): boolean {
    return other.label === this.label && other.depth === this.depth
  }

  toDOM(): HTMLElement {
    const mark = document.createElement('span')
    mark.className = 'cm-md-listMark'
    mark.style.setProperty('--md-depth', String(this.depth))
    if (this.label === '•') {
      // The browser's own marker, as in a rendered list: disc, then circle, then square when nested.
      const bullet = document.createElement('span')
      bullet.className = 'cm-md-bullet'
      bullet.style.listStyleType = BULLETS[Math.min(this.depth, BULLETS.length) - 1] ?? 'disc'
      mark.append(bullet)
    } else mark.textContent = `${this.label} `
    return mark
  }

  override ignoreEvent(): boolean {
    return false
  }
}

/** A task's checkbox: ticking it writes `[x]` (or `[ ]`) in the text. Named after its task. */
class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly label: string,
  ) {
    super()
  }

  override eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.label === this.label
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-md-task'
    box.checked = this.checked
    box.setAttribute('aria-label', this.label)
    box.setAttribute('aria-keyshortcuts', TASK_SHORTCUT)
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('change', () => {
      const from = view.posAtDOM(box)
      view.dispatch({ changes: { from: from + 1, to: from + 2, insert: box.checked ? 'x' : ' ' } })
    })
    return box
  }

  override ignoreEvent(): boolean {
    return true
  }
}

/** The key that ticks the tasks of the caret's lines (see `toggleTask`), as ARIA names it. */
export const TASK_SHORTCUT = 'Alt+Enter'

class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const rule = document.createElement('span')
    rule.className = 'cm-md-rule'
    rule.setAttribute('role', 'separator')
    return rule
  }

  override ignoreEvent(): boolean {
    return false
  }
}

const hidden = Decoration.replace({})

/** Strings the drawn elements need (accessible names). */
export interface LiveLabels {
  /** A task's checkbox, named after its text. */
  task: (text: string) => string
}

/** What the live view reads in the text. */
export interface LiveOptions {
  /** `{{cN::…}}` deletions are drawn (a cloze card's text); elsewhere they are plain text, as the renderer prints. */
  cloze: boolean
}

/** A table's photos: the URLs of the shas it references. */
function photosIn(source: string, urls: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const found = new Map<string, string>()
  for (const m of source.matchAll(PHOTO)) {
    const url = urls.get(m[2] ?? '')
    if (url !== undefined) found.set(m[2] ?? '', url)
  }
  return found
}

const setFocused = StateEffect.define<boolean>()
const setPointer = StateEffect.define<boolean>()

interface Reveal {
  focused: boolean
  /** A mouse button is down on the text. */
  pointer: boolean
  /** Where the syntax shows. */
  ranges: readonly Span[]
}

const NONE: readonly Span[] = []

const sameRanges = (a: readonly Span[], b: readonly Span[]) =>
  a.length === b.length && a.every((r, i) => r.from === b[i]?.from && r.to === b[i]?.to)

/**
 * Where the syntax comes back: the selection while the editor has the focus, nowhere otherwise. While a mouse
 * button is down it stays where it was, so the text does not move under the pointer (a drag ends where it is
 * released); it follows the selection once the button is up.
 */
const reveal = StateField.define<Reveal>({
  create: () => ({ focused: false, pointer: false, ranges: NONE }),
  update: (value, tr) => {
    let { focused, pointer } = value
    let released = false
    for (const e of tr.effects) {
      if (e.is(setFocused)) focused = e.value
      if (e.is(setPointer)) {
        released = pointer && !e.value
        pointer = e.value
      }
    }
    const keyboard = tr.isUserEvent('select') && !tr.isUserEvent('select.pointer')
    let ranges: readonly Span[]
    if (!focused) ranges = NONE
    else if (pointer && !released && !tr.docChanged && !keyboard) ranges = value.focused ? value.ranges : NONE
    else ranges = tr.state.selection.ranges.map((r) => ({ from: r.from, to: r.to }))
    if (focused === value.focused && pointer === value.pointer && sameRanges(ranges, value.ranges)) return value
    return { focused, pointer, ranges }
  },
})

function planOptions(state: EditorState, options: LiveOptions): [boolean, PlanOptions] {
  const r = state.field(reveal)
  return [r.focused, { reveal: r.ranges, cloze: options.cloze }]
}

/** The drawn blocks and the photos, over the whole text (their height is the text's). */
function blockDecorations(state: EditorState, options: LiveOptions): DecorationSet {
  const urls = state.field(photoUrls)
  const ranges: Range<Decoration>[] = []
  for (const item of planBlocks(state, ...planOptions(state, options))) {
    switch (item.kind) {
      case 'math':
        ranges.push(
          Decoration.replace({ widget: new MathWidget(item.source, true), block: true }).range(item.from, item.to),
        )
        break
      case 'table':
        ranges.push(
          Decoration.replace({ widget: new TableWidget(item.source, photosIn(item.source, urls)), block: true }).range(
            item.from,
            item.to,
          ),
        )
        break
      case 'photo': {
        const url = urls.get(item.sha)
        if (url === undefined) break
        if (!item.active && item.alone) {
          const widget = new PhotoWidget(url, item.alt, false)
          ranges.push(Decoration.replace({ widget, block: true }).range(item.lineFrom, item.lineTo))
          break
        }
        if (!item.active) ranges.push(hidden.range(item.from, item.to))
        const widget = new PhotoWidget(url, item.alt, true)
        ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(item.lineTo))
        break
      }
      default:
        break
    }
  }
  // A photo inside a drawn table is the table's own.
  const blocks = ranges.filter((r) => r.value.spec.block && r.from < r.to)
  return Decoration.set(
    ranges.filter((r) => !blocks.some((b) => b !== r && r.from >= b.from && r.to <= b.to)),
    true,
  )
}

/** The inline part over `window`, leaving out what a drawn block covers. */
function inlineDecorations(
  state: EditorState,
  window: Span,
  blocks: DecorationSet,
  options: LiveOptions,
  labels: LiveLabels,
): DecorationSet {
  const covering: Span[] = []
  blocks.between(window.from, window.to, (from, to, deco) => {
    if (deco.spec.block && from < to) covering.push({ from, to })
  })
  const covered = (from: number, to: number) => covering.some((b) => from >= b.from && to <= b.to)
  const [focused, plan] = planOptions(state, options)
  const ranges: Range<Decoration>[] = []
  for (const item of planInline(state, focused, { ...plan, within: window })) {
    const to = item.kind === 'line' ? item.at : item.to
    const from = item.kind === 'line' ? item.at : item.from
    if (covered(from, to)) continue
    switch (item.kind) {
      case 'hide':
        ranges.push(hidden.range(item.from, item.to))
        break
      case 'mark':
        ranges.push(Decoration.mark({ class: item.cls }).range(item.from, item.to))
        break
      case 'line':
        ranges.push(
          Decoration.line({ class: item.cls, ...(item.attrs ? { attributes: item.attrs } : {}) }).range(item.at),
        )
        break
      case 'math':
        ranges.push(Decoration.replace({ widget: new MathWidget(item.source, false) }).range(item.from, item.to))
        break
      case 'listMark':
        ranges.push(
          Decoration.replace({ widget: new ListMarkWidget(item.label, item.depth) }).range(item.from, item.to),
        )
        break
      case 'task':
        ranges.push(
          Decoration.replace({ widget: new TaskWidget(item.checked, labels.task(item.text)) }).range(
            item.from,
            item.to,
          ),
        )
        break
      case 'rule':
        ranges.push(Decoration.replace({ widget: new RuleWidget() }).range(item.from, item.to))
        break
      default:
        break
    }
  }
  return Decoration.set(ranges, true)
}

/**
 * ArrowDown (ArrowUp) onto a drawn table, formula or photo enters it, showing its source, instead of jumping over
 * it as over any widget.
 */
function enterBlock(blocks: StateField<DecorationSet>, forward: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view
    const { main } = state.selection
    if (state.selection.ranges.length > 1 || !main.empty) return false
    const line = state.doc.lineAt(main.head)
    const target = forward ? line.to + 1 : line.from - 1
    if (target < 0 || target > state.doc.length) return false
    // Still within a wrapped line: an ordinary move.
    const next = view.moveVertically(main, forward)
    if (forward ? next.head <= line.to : next.head >= line.from) return false
    const hits: Span[] = []
    state.field(blocks).between(target, target, (from, to, deco) => {
      if (deco.spec.block && from < to && (forward ? from === target : to === target)) hits.push({ from, to })
    })
    const found = hits[0]
    if (!found) return false
    const into = state.doc.lineAt(forward ? found.from : found.to)
    const column = main.head - line.from
    view.dispatch({
      selection: EditorSelection.cursor(Math.min(into.from + column, into.to)),
      scrollIntoView: true,
      userEvent: 'select',
    })
    return true
  }
}

/**
 * A double click selects the word under the first click: that click brought the element's syntax back in sight,
 * which moved the text, so the second one would land on a `**` or a `[`.
 */
function doubleClickWord(view: EditorView, event: MouseEvent): MouseSelectionStyle | null {
  if (event.detail !== 2 || event.button !== 0 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
    return null
  }
  const { main } = view.state.selection
  if (view.state.selection.ranges.length > 1 || !main.empty) return null
  const found = wordNear(view.state, main.head)
  if (!found) return null
  let word: Span = found
  return {
    get: (current) => {
      if (current === event) return EditorSelection.single(word.from, word.to)
      // Dragging on after the double click extends by words, over the text as it now stands.
      const pos = view.posAtCoords({ x: current.clientX, y: current.clientY }, false)
      const other = view.state.wordAt(pos) ?? EditorSelection.cursor(pos)
      return other.from < word.from
        ? EditorSelection.single(word.to, other.from)
        : EditorSelection.single(word.from, Math.max(word.to, other.to))
    },
    update: (update) => {
      if (update.docChanged) word = { from: update.changes.mapPos(word.from), to: update.changes.mapPos(word.to) }
    },
  }
}

/**
 * Live Markdown: the text reads as the renderer draws it while it is written. The syntax of the element under the
 * caret (or the selection) comes back to be edited; everything else is drawn. The text itself stays plain Markdown.
 * Drawn blocks span the whole text; the rest is drawn over the part near the screen, so a keystroke costs the
 * same in a long note as in a short one.
 */
export function livePreview(labels: LiveLabels, options: LiveOptions): Extension {
  const blocks = StateField.define<DecorationSet>({
    create: (state) => blockDecorations(state, options),
    update: (value, tr) =>
      tr.docChanged ||
      tr.state.field(reveal) !== tr.startState.field(reveal, false) ||
      tr.effects.some((e) => e.is(setPhotoUrls)) ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
        ? blockDecorations(tr.state, options)
        : value.map(tr.changes),
    provide: (f) => EditorView.decorations.from(f),
  })

  const inline = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = inlineDecorations(view.state, view.viewport, view.state.field(blocks), options, labels)
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.state.field(reveal) !== u.startState.field(reveal, false) ||
          u.state.field(blocks) !== u.startState.field(blocks, false) ||
          syntaxTree(u.state) !== syntaxTree(u.startState)
        ) {
          this.decorations = inlineDecorations(u.state, u.view.viewport, u.state.field(blocks), options, labels)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )

  /** Follows the mouse button: down on the text, then up anywhere (after the editor's own handling of it). */
  const pointer = ViewPlugin.fromClass(
    class {
      done = false
      constructor(readonly view: EditorView) {}
      release = () => {
        removeEventListener('mouseup', this.release)
        if (!this.done && this.view.state.field(reveal).pointer) this.view.dispatch({ effects: setPointer.of(false) })
      }
      destroy() {
        this.done = true
        removeEventListener('mouseup', this.release)
      }
    },
    {
      eventHandlers: {
        mousedown(e) {
          if (e.button !== 0) return false
          this.view.dispatch({ effects: setPointer.of(true) })
          addEventListener('mouseup', this.release)
          return false
        },
      },
    },
  )

  return [
    reveal,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
    pointer,
    blocks,
    inline,
    EditorView.mouseSelectionStyle.of(doubleClickWord),
    Prec.high(
      keymap.of([
        { key: 'ArrowDown', run: enterBlock(blocks, true) },
        { key: 'ArrowUp', run: enterBlock(blocks, false) },
      ]),
    ),
    EditorView.editorAttributes.of({ class: proseStyles.live ?? '' }),
  ]
}

/** The source view: the raw Markdown, each photo shown under the line that references it. */
export function sourcePhotos(): Extension {
  const decorations = StateField.define<DecorationSet>({
    create: (state) => sourcePhotoDecorations(state),
    update: (value, tr) =>
      tr.docChanged || tr.effects.some((e) => e.is(setPhotoUrls))
        ? sourcePhotoDecorations(tr.state)
        : value.map(tr.changes),
    provide: (f) => EditorView.decorations.from(f),
  })
  return decorations
}

function sourcePhotoDecorations(state: EditorState): DecorationSet {
  const urls = state.field(photoUrls)
  const widgets: Range<Decoration>[] = []
  for (const m of state.doc.toString().matchAll(PHOTO)) {
    const url = urls.get(m[2] ?? '')
    if (url === undefined) continue
    const line = state.doc.lineAt(m.index + m[0].length)
    widgets.push(
      Decoration.widget({ widget: new PhotoWidget(url, m[1] ?? '', true), block: true, side: 1 }).range(line.to),
    )
  }
  return Decoration.set(widgets, true)
}
