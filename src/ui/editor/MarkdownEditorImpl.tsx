import {
  cursorDocEnd,
  cursorDocStart,
  defaultKeymap,
  indentWithTab,
  selectDocEnd,
  selectDocStart,
} from '@codemirror/commands'
import { Compartment, EditorSelection, EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view'
import { Redo2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { blobIdsIn, photoMarkdown } from '../../core/content/photos'
import { getPhoto, photoLabel } from '../../core/model/photos'
import { useT } from '../../i18n/react.tsx'
import { capturePhotos } from '../../screens/Photos/capture.ts'
import { useBlobResolver } from '../../screens/Photos/files.ts'
import { useUntitled } from '../../screens/Photos/text.ts'
import { noteError } from '../../screens/settings/Diagnostic/recent.ts'
import { IconButton } from '../components/IconButton.tsx'
import { type Anchor, LinkPopover, MathPopover, TablePopover } from './EditorPopover.tsx'
import {
  activeFormats,
  type Format,
  linkAddress,
  linkMarkdown,
  mathMarkdown,
  parseTable,
  pendingFormat,
  setHeading,
  tableMarkdown,
  toggleList,
  toggleMarker,
  toggleQuote,
  toggleTask,
} from './format.ts'
import { linkAt, liveMarkdown, mathAt, tableAt } from './livePlan.ts'
import {
  type LiveActions,
  type LiveLabels,
  type LiveOptions,
  livePreview,
  photoUrls,
  setPhotoUrls,
  sourcePhotos,
} from './livePreview.ts'
import styles from './MarkdownEditor.module.css'
import type { MarkdownEditorProps } from './MarkdownEditor.tsx'
import { readShowMarkdown, writeShowMarkdown } from './prefs.ts'
import { Toolbar } from './Toolbar.tsx'

/** Applies a formatting command to the editor, then gives it the focus back. */
function apply(view: EditorView, spec: TransactionSpec | null): boolean {
  if (spec === null) return false
  view.dispatch(spec, { scrollIntoView: true, userEvent: 'input.format' })
  view.focus()
  return true
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
  // A drawn formula, table or link opens its editor.
  '.cm-md-math, .cm-md-table, .cm-md-link': { cursor: 'pointer' },
  '.cm-md-task': { marginInlineEnd: '0.5em' },
})

/** The text as it reads (live) or its raw Markdown (source). */
function view(source: boolean, labels: LiveLabels, options: LiveOptions, actions: LiveActions): Extension {
  return source ? sourcePhotos() : livePreview(labels, options, actions)
}

/** Pasted HTML worth keeping as formatting (a plain run of text pastes as text). */
const RICH = /<(b|strong|i|em|s|del|h[1-6]|ul|ol|li|a\s|table|blockquote|code|pre|img)\b/i

/** What a popover is editing: where it sits in the text, and what it shows. */
type Editing =
  | {
      kind: 'link'
      anchor: Anchor
      from: number
      to: number
      url: string
      text: string | null
      existing: boolean
      focus: boolean
    }
  | { kind: 'math'; anchor: Anchor; from: number; to: number; latex: string; block: boolean }
  | { kind: 'table'; anchor: Anchor; from: number; to: number; rows: string[][]; existing: boolean }

function anchorAt(v: EditorView, pos: number): Anchor {
  const at = v.coordsAtPos(pos) ?? v.contentDOM.getBoundingClientRect()
  return { left: at.left, top: at.top, bottom: at.bottom }
}

export default function MarkdownEditorImpl({ text, label, placeholder, cloze = false, photos }: MarkdownEditorProps) {
  const t = useT()
  const rt = useRuntime()
  const untitled = useUntitled()
  const host = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const editor = useRef<EditorView | null>(null)
  const mode = useRef(new Compartment())
  const [source, setSource] = useState(readShowMarkdown)
  const sourceNow = useRef(source)
  sourceNow.current = source
  const [undo, setUndo] = useState<Y.UndoManager | null>(null)
  const [active, setActive] = useState<ReadonlySet<Format>>(new Set())
  const [editing, setEditing] = useState<Editing | null>(null)
  const [photoFailed, setPhotoFailed] = useState(false)
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

  /**
   * Opens the link editor on the link at `at` (the caret by default), or for a new one over the selection. A tap
   * on a link shows its card and leaves the focus in the text (`focus` false).
   */
  const openLink = (v: EditorView, at?: number, focus = true): boolean => {
    const { state } = v
    const pos = at ?? state.selection.main.head
    const link = linkAt(state, pos)
    if (link) {
      const { from, to, url } = link
      setEditing({ kind: 'link', anchor: anchorAt(v, link.textFrom), from, to, url, text: null, existing: true, focus })
      return true
    }
    const { from, to } = state.selection.main
    setEditing({
      kind: 'link',
      anchor: anchorAt(v, from),
      from,
      to,
      url: '',
      text: from === to ? '' : null,
      existing: false,
      focus: true,
    })
    return true
  }

  /** Opens the formula editor on the formula at `at` (the caret by default), or for a new one. */
  const openMath = (v: EditorView, at?: number): boolean => {
    const { state } = v
    const math = mathAt(state, at ?? state.selection.main.head)
    if (math) {
      setEditing({ kind: 'math', anchor: anchorAt(v, math.from), ...math })
      return true
    }
    const { from, to } = state.selection.main
    setEditing({
      kind: 'math',
      anchor: anchorAt(v, from),
      from,
      to,
      latex: state.doc.sliceString(from, to),
      block: false,
    })
    return true
  }

  /** Opens the table editor on the table at `at` (the caret by default), or for a new one under the caret's line. */
  const openTable = (v: EditorView, at?: number): boolean => {
    const { state } = v
    const table = tableAt(state, at ?? state.selection.main.head)
    if (table) {
      setEditing({
        kind: 'table',
        anchor: anchorAt(v, table.from),
        ...table,
        rows: parseTable(table.source),
        existing: true,
      })
      return true
    }
    const line = state.doc.lineAt(state.selection.main.head)
    setEditing({
      kind: 'table',
      anchor: anchorAt(v, line.from),
      // An empty line becomes the table; otherwise it goes under the caret's line.
      from: line.text.trim() === '' ? line.from : line.to,
      to: line.to,
      rows: [
        [t('common.edTableColumn', { n: 1 }), t('common.edTableColumn', { n: 2 })],
        ['', ''],
      ],
      existing: false,
    })
    return true
  }

  const commands: Record<Format, (v: EditorView) => boolean> = {
    bold: (v) => apply(v, toggleMarker(v.state, '**')),
    italic: (v) => apply(v, toggleMarker(v.state, '*')),
    strike: (v) => apply(v, toggleMarker(v.state, '~~')),
    code: (v) => apply(v, toggleMarker(v.state, '`')),
    h1: (v) => apply(v, setHeading(v.state, 1)),
    h2: (v) => apply(v, setHeading(v.state, 2)),
    h3: (v) => apply(v, setHeading(v.state, 3)),
    bullet: (v) => apply(v, toggleList(v.state, 'bullet')),
    numbered: (v) => apply(v, toggleList(v.state, 'numbered')),
    task: (v) => apply(v, toggleList(v.state, 'task')),
    quote: (v) => apply(v, toggleQuote(v.state)),
    link: (v) => openLink(v),
    math: (v) => openMath(v),
    table: (v) => openTable(v),
  }
  // The editor is built once per text: its keys and its drawn elements reach the latest commands through these.
  const commandsNow = useRef(commands)
  commandsNow.current = commands
  const actions = useRef<LiveActions>({
    link: (at) => {
      const v = editor.current
      if (v) openLinkAt.current(v, at, false)
    },
    math: (at) => {
      const v = editor.current
      if (v) openMathAt.current(v, at)
    },
    table: (at) => {
      const v = editor.current
      if (v) openTableAt.current(v, at)
    },
  })
  const openLinkAt = useRef(openLink)
  openLinkAt.current = openLink
  const openMathAt = useRef(openMath)
  openMathAt.current = openMath
  const openTableAt = useRef(openTable)
  openTableAt.current = openTable

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const undoManager = new Y.UndoManager(text)
    const run = (f: Format) => (v: EditorView) => !sourceNow.current && commandsNow.current[f](v)
    let shown = ''
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          keymap.of([
            { key: 'Mod-b', run: run('bold') },
            { key: 'Mod-i', run: run('italic') },
            { key: 'Mod-k', run: run('link') },
            { key: 'Mod-Shift-7', run: run('numbered') },
            { key: 'Mod-Shift-8', run: run('bullet') },
            { key: 'Mod-Shift-9', run: run('task') },
            { key: 'Alt-Enter', run: (ed) => apply(ed, toggleTask(ed.state)) },
            ...yUndoManagerKeymap,
            // An iPad counts as a Mac (Mod is Cmd), but a PC-layout keyboard still sends Ctrl-Home/End.
            { key: 'Ctrl-Home', run: cursorDocStart, shift: selectDocStart, preventDefault: true },
            { key: 'Ctrl-End', run: cursorDocEnd, shift: selectDocEnd, preventDefault: true },
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
          mode.current.of(view(sourceNow.current, labels.current, { cloze: clozeNow.current }, actions.current)),
          yCollab(text, null, { undoManager }),
          // The toolbar shows the formats in effect where the caret is.
          EditorView.updateListener.of((u) => {
            const waiting = u.state.field(pendingFormat, false) !== u.startState.field(pendingFormat, false)
            if (!u.selectionSet && !u.docChanged && !waiting) return
            // A link's card shown by a tap goes once the caret leaves the link.
            const at = linkAt(u.state, u.state.selection.main.head)?.from
            setEditing((e) => (e?.kind === 'link' && !e.focus && at !== e.from ? null : e))
            const now = activeFormats(u.state)
            const key = [...now].sort().join()
            if (key === shown) return
            shown = key
            setActive(now)
          }),
          // Formatted text pasted from a page or a document arrives as Markdown; plain text stays plain. The
          // editor's own copy is its Markdown, as text.
          EditorView.domEventHandlers({
            paste(e, ed) {
              const html = e.clipboardData?.getData('text/html') ?? ''
              if (!RICH.test(html)) return false
              e.preventDefault()
              void import('../../core/anki/htmlToMd').then(({ turndownConverter }) => {
                const md = turndownConverter(html).trim()
                ed.dispatch(ed.state.replaceSelection(md), { scrollIntoView: true, userEvent: 'input.paste' })
              })
              return true
            },
          }),
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
      effects: mode.current.reconfigure(view(sourceNow.current, { task: taskLabel }, { cloze }, actions.current)),
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
    writeShowMarkdown(next)
    setEditing(null)
    editor.current?.dispatch({
      effects: mode.current.reconfigure(view(next, labels.current, { cloze }, actions.current)),
    })
  }

  const format = (f: Format) => {
    const v = editor.current
    if (v) commands[f](v)
  }

  /** Replaces `from`–`to` with `insert`, the caret after it, and gives the text the focus back. */
  const write = (from: number, to: number, insert: string) => {
    const v = editor.current
    setEditing(null)
    if (!v) return
    v.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.cursor(from + insert.length),
      scrollIntoView: true,
      userEvent: 'input.format',
    })
    v.focus()
  }

  const close = () => {
    setEditing(null)
    editor.current?.focus()
  }

  const addPhotos = (files: File[]) => {
    const where = photos
    const v = editor.current
    if (!where || !v || files.length === 0) return
    setPhotoFailed(false)
    capturePhotos(rt, where, files, untitled).then(
      (r) => {
        setPhotoFailed(r.failed.length > 0)
        const refs = r.ids.flatMap((id, i) => {
          const blobId = r.blobIds[i]
          const photo = getPhoto(rt.ws, id)
          return blobId === undefined ? [] : [photoMarkdown(blobId, photo ? photoLabel(photo) : '')]
        })
        const ed = editor.current
        if (!ed || refs.length === 0) return
        // Each photo on a line of its own, under the caret's line.
        const line = ed.state.doc.lineAt(ed.state.selection.main.head)
        const empty = line.text.trim() === ''
        const insert = `${empty ? '' : '\n\n'}${refs.join('\n\n')}`
        write(empty ? line.from : line.to, line.to, insert)
      },
      (e: unknown) => {
        noteError('photos.capture', e)
        setPhotoFailed(true)
      },
    )
  }

  return (
    <div className={styles.frame}>
      <Toolbar
        source={source}
        photo={photos !== undefined}
        live={{
          onSource: showSource,
          onFormat: format,
          onPhoto: () => picker.current?.click(),
          active,
          history: <UndoButtons undo={undo} />,
        }}
      />
      {photos !== undefined && (
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addPhotos([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
      )}
      {photoFailed && (
        <p className={styles.failed} role="alert">
          {t('common.edPhotoFailed')}
        </p>
      )}
      <div ref={host} className={styles.host} />
      {editing?.kind === 'link' && (
        <LinkPopover
          anchor={editing.anchor}
          url={editing.url}
          text={editing.text}
          focus={editing.focus}
          onClose={close}
          onRemove={
            editing.existing
              ? () => {
                  const v = editor.current
                  const link = v ? linkAt(v.state, editing.from) : null
                  if (v && link) write(link.from, link.to, v.state.doc.sliceString(link.textFrom, link.textTo))
                }
              : null
          }
          onApply={(url, label) => {
            const v = editor.current
            if (!v) return
            if (editing.existing) {
              const link = linkAt(v.state, editing.from)
              if (link) write(link.textTo, link.to, `](${linkAddress(url)})`)
            } else if (editing.text === null) {
              const selected = v.state.doc.sliceString(editing.from, editing.to)
              write(editing.from, editing.to, `[${selected}](${linkAddress(url)})`)
            } else write(editing.from, editing.to, linkMarkdown(label, url))
          }}
        />
      )}
      {editing?.kind === 'math' && (
        <MathPopover
          anchor={editing.anchor}
          latex={editing.latex}
          block={editing.block}
          onClose={close}
          onApply={(latex) => write(editing.from, editing.to, mathMarkdown(latex, editing.block))}
        />
      )}
      {editing?.kind === 'table' && (
        <TablePopover
          anchor={editing.anchor}
          rows={editing.rows}
          onClose={close}
          onApply={(rows) => {
            const v = editor.current
            if (!v) return
            const md = tableMarkdown(rows)
            if (editing.existing) {
              write(editing.from, editing.to, md)
              return
            }
            // Blank lines set it apart: text right above or below would be read into the table.
            const { doc } = v.state
            const line = doc.lineAt(editing.to)
            const next = line.number < doc.lines ? doc.line(line.number + 1) : null
            const before = editing.from === editing.to && line.text.trim() !== '' ? '\n\n' : ''
            const after = next && next.text.trim() !== '' ? '\n' : ''
            write(editing.from, editing.to, `${before}${md}${after}`)
          }}
        />
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
