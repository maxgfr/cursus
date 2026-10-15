import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view'
import { Redo2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { blobIdsIn } from '../../core/content/photos'
import { useT } from '../../i18n/react.tsx'
import { useBlobResolver } from '../../screens/Photos/files.ts'
import { IconButton } from '../components/IconButton.tsx'
import { prefixLines, toggleMarker, toggleTask } from './format.ts'
import { liveMarkdown } from './livePlan.ts'
import { type LiveLabels, type LiveOptions, livePreview, photoUrls, setPhotoUrls, sourcePhotos } from './livePreview.ts'
import styles from './MarkdownEditor.module.css'
import type { MarkdownEditorProps } from './MarkdownEditor.tsx'
import { type Format, Toolbar } from './Toolbar.tsx'

/** Applies a formatting command to the editor, then gives it the focus back. */
function apply(view: EditorView, spec: TransactionSpec | null): boolean {
  if (spec === null) return false
  view.dispatch(spec, { scrollIntoView: true, userEvent: 'input.format' })
  view.focus()
  return true
}

const FORMAT: Record<Format, (view: EditorView) => boolean> = {
  bold: (v) => apply(v, toggleMarker(v.state, '**')),
  italic: (v) => apply(v, toggleMarker(v.state, '*')),
  heading: (v) => apply(v, prefixLines(v.state, '## ')),
  list: (v) => apply(v, prefixLines(v.state, '- ')),
  math: (v) => apply(v, toggleMarker(v.state, '$')),
  code: (v) => apply(v, toggleMarker(v.state, '`')),
}

const theme = EditorView.theme({
  '&': {
    color: 'var(--ink)',
    backgroundColor: 'transparent',
    // As the rendered text (16 px at least: iOS zooms into smaller fields).
    fontSize: 'max(16px, var(--text-body))',
  },
  '.cm-content': {
    padding: 'var(--space-4)',
    fontFamily: 'var(--font-sans)',
    lineHeight: '1.55',
    caretColor: 'var(--accent)',
  },
  // Lines start where rendered text starts.
  '.cm-line': { padding: '0' },
  '.cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.55' },
  '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '-2px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-placeholder': { color: 'var(--ink-3)' },
  '.cm-ySelectionInfo': { display: 'none' },
  // Under a line of text, a photo is set off from it; in place of its line, the blank lines around make the gap.
  '.cm-photoUnder': { padding: 'var(--space-2) 0' },
  '.cm-photoPreview img': { display: 'block' },
})

/** The text as it reads (live) or its raw Markdown (source). */
function view(source: boolean, labels: LiveLabels, options: LiveOptions): Extension {
  return source ? sourcePhotos() : livePreview(labels, options)
}

export default function MarkdownEditorImpl({ text, label, placeholder, cloze = false }: MarkdownEditorProps) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const mode = useRef(new Compartment())
  const [source, setSource] = useState(false)
  const sourceNow = useRef(source)
  sourceNow.current = source
  const [undo, setUndo] = useState<Y.UndoManager | null>(null)
  const taskLabel = useCallback(
    (task: string) => (task === '' ? t('common.edTask') : t('common.edTaskOf', { task })),
    [t],
  )
  const labels = useRef<LiveLabels>({ task: taskLabel })
  labels.current = { task: taskLabel }
  const clozeNow = useRef(cloze)
  clozeNow.current = cloze
  /** What the live view was last configured with. */
  const configured = useRef({ taskLabel, cloze })
  // The text as it stands, so its photos can be loaded and shown in the editor.
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
            { key: 'Mod-b', run: FORMAT.bold },
            { key: 'Mod-i', run: FORMAT.italic },
            { key: 'Alt-Enter', run: (ed) => apply(ed, toggleTask(ed.state)) },
            ...yUndoManagerKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          liveMarkdown(),
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
          photoUrls,
          mode.current.of(view(sourceNow.current, labels.current, { cloze: clozeNow.current })),
          yCollab(text, null, { undoManager }),
        ],
      }),
    })
    editor.current = v
    configured.current = { taskLabel: labels.current.task, cloze: clozeNow.current }
    setUndo(undoManager)
    return () => {
      v.destroy()
      undoManager.destroy()
      editor.current = null
      setUndo(null)
    }
  }, [text, label, placeholder])

  // A change of language (task names) or of card kind (cloze read or not) redraws the text, not the editor.
  useEffect(() => {
    const last = configured.current
    if (last.taskLabel === taskLabel && last.cloze === cloze) return
    configured.current = { taskLabel, cloze }
    editor.current?.dispatch({
      effects: mode.current.reconfigure(view(sourceNow.current, { task: taskLabel }, { cloze })),
    })
  }, [taskLabel, cloze])

  // The editor is created once per text: the photos' URLs reach it as an effect whenever they load.
  useEffect(() => {
    const v = editor.current
    if (!v) return
    const urls = new Map<string, string>()
    for (const id of blobIdsIn(current)) {
      const url = resolveBlob?.(id)
      if (url) urls.set(id, url)
    }
    v.dispatch({ effects: setPhotoUrls.of(urls) })
  }, [current, resolveBlob])

  const showSource = (next: boolean) => {
    setSource(next)
    editor.current?.dispatch({ effects: mode.current.reconfigure(view(next, labels.current, { cloze })) })
  }

  const format = (f: Format) => {
    const v = editor.current
    if (v) FORMAT[f](v)
  }

  return (
    <div className={styles.frame}>
      <Toolbar
        source={source}
        live={{ onSource: showSource, onFormat: format, history: <UndoButtons undo={undo} /> }}
      />
      <div ref={host} className={styles.host} />
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
