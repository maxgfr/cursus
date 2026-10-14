import 'katex/dist/katex.min.css'
import { useMemo } from 'react'
import { type BlobResolver, renderMarkdown } from '../../core/content/markdown'
import styles from './Sanitized.module.css'

/** The ONLY place raw HTML reaches the DOM: Markdown rendered then sanitized by DOMPurify. */
export function Sanitized({ markdown, resolveBlob }: { markdown: string; resolveBlob?: BlobResolver }) {
  const html = useMemo(() => renderMarkdown(markdown, resolveBlob ? { resolveBlob } : {}), [markdown, resolveBlob])
  return <div className={styles.prose} dangerouslySetInnerHTML={{ __html: html }} />
}
