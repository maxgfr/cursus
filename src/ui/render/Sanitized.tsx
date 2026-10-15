import 'katex/dist/katex.min.css'
import { useMemo } from 'react'
import { type BlobResolver, renderMarkdown, renderMarkdownInline } from '../../core/content/markdown'
import styles from './Sanitized.module.css'

/*
 * The only module where HTML reaches the DOM, through its two sinks below: Markdown rendered then sanitized by
 * DOMPurify, never raw HTML.
 */

/** Rendered Markdown, read-only. */
export function Sanitized({ markdown, resolveBlob }: { markdown: string; resolveBlob?: BlobResolver }) {
  const html = useMemo(() => renderMarkdown(markdown, resolveBlob ? { resolveBlob } : {}), [markdown, resolveBlob])
  return <div className={styles.prose} dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * The same pipeline for a node built outside React (the live editor's formulas and tables): Markdown rendered then
 * sanitized by DOMPurify, its photos resolved as in `Sanitized`.
 */
export function fillSanitized(
  host: HTMLElement,
  markdown: string,
  { inline = false, resolveBlob }: { inline?: boolean; resolveBlob?: BlobResolver } = {},
) {
  const options = resolveBlob ? { resolveBlob } : {}
  host.innerHTML = inline ? renderMarkdownInline(markdown, options) : renderMarkdown(markdown, options)
}
