import { Suspense } from 'react'
import type * as Y from 'yjs'
import { lazyChunk } from '../../app/lazyChunk.tsx'
import { useT } from '../../i18n/react.tsx'
import { cx } from '../cx.ts'
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
          <Toolbar source={false} />
          <p className={cx(styles.host, styles.loading)}>{t('common.edLoading')}</p>
        </div>
      }
    >
      <Impl {...props} />
    </Suspense>
  )
}
