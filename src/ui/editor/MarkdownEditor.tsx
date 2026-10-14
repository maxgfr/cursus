import { Suspense } from 'react'
import type * as Y from 'yjs'
import { lazyChunk } from '../../app/lazyChunk.tsx'
import { useT } from '../../i18n/react.tsx'
import styles from './MarkdownEditor.module.css'

export interface MarkdownEditorProps {
  /** A Y.Text obtained from `workspace.text(...)`. */
  text: Y.Text
  /** Accessible name of the editing area. */
  label: string
  placeholder?: string
  /** Opens on the preview instead of the source. */
  initialMode?: 'write' | 'preview'
}

const Impl = lazyChunk('editor', () => import('./MarkdownEditorImpl.tsx'))

/** Loads CodeMirror on demand so it never weighs on the first paint. */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const t = useT()
  return (
    <Suspense
      fallback={
        <div className={styles.frame} aria-busy="true">
          <p className={styles.loading}>{t('common.edLoading')}</p>
        </div>
      }
    >
      <Impl {...props} />
    </Suspense>
  )
}
