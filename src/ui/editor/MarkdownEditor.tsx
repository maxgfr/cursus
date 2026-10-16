import { Suspense } from 'react'
import type * as Y from 'yjs'
import { lazyChunk } from '../../app/lazyChunk.tsx'
import type { Id } from '../../core/contracts/workspace'
import { useT } from '../../i18n/react.tsx'
import { cx } from '../cx.ts'
import type { EditorWriter } from './aiWrite.ts'
import styles from './MarkdownEditor.module.css'
import { Toolbar } from './Toolbar.tsx'

export interface MarkdownEditorProps {
  /** A Y.Text obtained from `workspace.text(...)`. */
  text: Y.Text
  /** Accessible name of the editing area. */
  label: string
  placeholder?: string
  /**
   * The text is a cloze card's: its `{{cN::…}}` deletions are drawn as the review shows them. Elsewhere they are
   * plain text, as the renderer prints them.
   */
  cloze?: boolean
  /** Where a photo added from the toolbar is kept (its course, its section); no photo button without it. */
  photos?: { courseId: Id; sectionId?: Id }
  /** Given how an AI writes into the text (one undo step in all) once the editor is there; null once it is gone. */
  writer?: (writer: EditorWriter | null) => void
}

const Impl = lazyChunk('editor', () => import('./MarkdownEditorImpl.tsx'))

/** Loads CodeMirror on demand so it never weighs on the first paint. */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const t = useT()
  return (
    <Suspense
      fallback={
        // The editor's own frame, toolbar included: what sits below does not move when the editor arrives.
        <div className={styles.frame} aria-busy="true">
          <Toolbar source={false} photo={props.photos !== undefined} cloze={props.cloze} />
          <p className={cx(styles.host, styles.loading)}>{t('common.edLoading')}</p>
        </div>
      }
    >
      <Impl {...props} />
    </Suspense>
  )
}
