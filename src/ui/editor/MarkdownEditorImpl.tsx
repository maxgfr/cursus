import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, type Extension, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder as placeholderExt,
  WidgetType,
} from '@codemirror/view'
import { Redo2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { blobIdsIn } from '../../core/content/photos'
import { useT } from '../../i18n/react.tsx'
import { useBlobResolver } from '../../screens/Photos/files.ts'
import { IconButton } from '../components/IconButton.tsx'
import { Sanitized } from '../render/Sanitized.tsx'
import styles from './MarkdownEditor.module.css'
import type { MarkdownEditorProps } from './MarkdownEditor.tsx'
import { type Format, Toolbar } from './Toolbar.tsx'

/** Wraps the selection (or inserts a pair at the caret) with `before`/`after`. */
function wrap(view: EditorView, before: string, after = before): boolean {
  view.dispatch(
    view.state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: before },
        { from: range.to, insert: after },
      ],
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    })),
  )
  view.focus()
  return true
}

/** Prefixes every selected line with `prefix` (toggles it off when all lines have it). */
function prefixLines(view: EditorView, prefix: string): boolean {
  const { state } = view
  const lines = new Set<number>()
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to; ) {
      const line = state.doc.lineAt(pos)
      lines.add(line.number)
      pos = line.to + 1
    }
  }
  const all = [...lines].map((n) => state.doc.line(n))
  const remove = all.every((l) => l.text.startsWith(prefix))
  view.dispatch({
    changes: all.map((l) =>
      remove ? { from: l.from, to: l.from + prefix.length, insert: '' } : { from: l.from, insert: prefix },
    ),
  })
  view.focus()
  return true
}

const FORMAT: Record<Format, (view: EditorView) => boolean> = {
  bold: (v) => wrap(v, '**'),
  italic: (v) => wrap(v, '*'),
  heading: (v) => prefixLines(v, '## '),
  list: (v) => prefixLines(v, '- '),
  math: (v) => wrap(v, '$'),
  code: (v) => wrap(v, '`'),
}

/** A stored photo in the text (`![caption](cursus-blob:<sha256>)`). */
const PHOTO = /!\[([^\]\n]*)\]\(cursus-blob:([0-9a-f]{64})\)/g

/** The displayable URLs of the photos the text holds, set from outside once they are loaded. */
const setPhotoUrls = StateEffect.define<ReadonlyMap<string, string>>()

/** The photo itself, shown under the line that references it; the reference stays editable above. */
class PhotoWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
  ) {
    super()
  }

  override eq(other: PhotoWidget): boolean {
    return other.url === this.url && other.alt === this.alt
  }

  toDOM(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-photoPreview'
    const img = document.createElement('img')
    img.src = this.url
    img.alt = this.alt
    img.loading = 'lazy'
    img.decoding = 'async'
    box.append(img)
    return box
  }
}

function photoDecorations(state: EditorState, urls: ReadonlyMap<string, string>): DecorationSet {
  const widgets = []
  const text = state.doc.toString()
  for (const m of text.matchAll(PHOTO)) {
    const url = urls.get(m[2] ?? '')
    if (url === undefined) continue
    const line = state.doc.lineAt(m.index + m[0].length)
    widgets.push(Decoration.widget({ widget: new PhotoWidget(url, m[1] ?? ''), block: true, side: 1 }).range(line.to))
  }
  return Decoration.set(widgets, true)
}

/** Previews of the photos in the text, under their lines, as soon as their files are available. */
function photoPreviews(): Extension {
  const urls = StateField.define<ReadonlyMap<string, string>>({
    create: () => new Map(),
    update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setPhotoUrls) ? e.value : v), value),
  })
  const decorations = StateField.define<DecorationSet>({
    create: (state) => photoDecorations(state, state.field(urls)),
    update: (value, tr) =>
      tr.docChanged || tr.effects.some((e) => e.is(setPhotoUrls))
        ? photoDecorations(tr.state, tr.state.field(urls))
        : value.map(tr.changes),
    provide: (f) => EditorView.decorations.from(f),
  })
  return [urls, decorations]
}

const theme = EditorView.theme({
  '&': {
    color: 'var(--ink)',
    backgroundColor: 'transparent',
    fontSize: 'max(1rem, 16px)',
  },
  '.cm-content': {
    padding: 'var(--space-4)',
    fontFamily: 'var(--font-sans)',
    lineHeight: '1.55',
    caretColor: 'var(--accent)',
  },
  '.cm-scroller': { fontFamily: 'var(--font-sans)' },
  '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '-2px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-placeholder': { color: 'var(--ink-3)' },
  '.cm-ySelectionInfo': { display: 'none' },
  '.cm-photoPreview': { padding: 'var(--space-2) 0' },
  '.cm-photoPreview img': {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '14rem',
    borderRadius: 'var(--radius-control)',
    objectFit: 'contain',
  },
})

export default function MarkdownEditorImpl({ text, label, placeholder, initialMode = 'write' }: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [mode, setMode] = useState(initialMode)
  const [undo, setUndo] = useState<Y.UndoManager | null>(null)
  // The text as it stands, so its photos can be loaded and shown, in the editor and in the preview.
  const subscribeText = useCallback(
    (fn: () => void) => {
      text.observe(fn)
      return () => text.unobserve(fn)
    },
    [text],
  )
  const current = useSyncExternalStore(subscribeText, () => text.toString())
  const resolveBlob = useBlobResolver(current)

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const undoManager = new Y.UndoManager(text)
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          keymap.of([
            { key: 'Mod-b', run: (ed) => wrap(ed, '**') },
            { key: 'Mod-i', run: (ed) => wrap(ed, '*') },
            ...yUndoManagerKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          markdown(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': label,
            'aria-multiline': 'true',
            enterkeyhint: 'enter',
            autocapitalize: 'sentences',
            spellcheck: 'true',
          }),
          placeholder ? placeholderExt(placeholder) : [],
          theme,
          photoPreviews(),
          yCollab(text, null, { undoManager }),
        ],
      }),
    })
    view.current = v
    setUndo(undoManager)
    return () => {
      v.destroy()
      undoManager.destroy()
      view.current = null
      setUndo(null)
    }
  }, [text, label, placeholder])

  // The editor is created once per text: the photos' URLs reach it as an effect whenever they load.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const urls = new Map<string, string>()
    for (const id of blobIdsIn(current)) {
      const url = resolveBlob?.(id)
      if (url) urls.set(id, url)
    }
    v.dispatch({ effects: setPhotoUrls.of(urls) })
  }, [current, resolveBlob])

  const format = (f: Format) => {
    const v = view.current
    if (v) FORMAT[f](v)
  }

  return (
    <div className={styles.frame}>
      <Toolbar mode={mode} live={{ onMode: setMode, onFormat: format, history: <UndoButtons undo={undo} /> }} />
      <div ref={host} className={styles.host} hidden={mode !== 'write'} />
      {mode === 'preview' && (
        <div className={styles.preview}>
          <Sanitized markdown={current} {...(resolveBlob ? { resolveBlob } : {})} />
        </div>
      )}
    </div>
  )
}

function UndoButtons({ undo }: { undo: Y.UndoManager | null }) {
  const t = useT()
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!undo) return () => {}
      undo.on('stack-item-added', fn)
      undo.on('stack-item-popped', fn)
      undo.on('stack-cleared', fn)
      return () => {
        undo.off('stack-item-added', fn)
        undo.off('stack-item-popped', fn)
        undo.off('stack-cleared', fn)
      }
    },
    [undo],
  )
  const canUndo = useSyncExternalStore(subscribe, () => undo?.canUndo() ?? false)
  const canRedo = useSyncExternalStore(subscribe, () => undo?.canRedo() ?? false)
  return (
    <div className={styles.group}>
      <IconButton icon={Undo2} label={t('common.undo')} disabled={!canUndo} onClick={() => undo?.undo()} />
      <IconButton icon={Redo2} label={t('common.redo')} disabled={!canRedo} onClick={() => undo?.redo()} />
    </div>
  )
}
