import 'katex/dist/katex.min.css'
import { useMemo } from 'react'
import { type BlobResolver, renderMarkdown, renderMarkdownInline } from '../../core/content/markdown'
import styles from './Sanitized.module.css'

/*
 * The only module where HTML reaches the DOM, through its two sinks below: Markdown rendered then sanitized by
 * DOMPurify, never raw HTML.
 */

/**
 * Rendered Markdown, read-only. `lineBreaks` keeps every line break (text read from a file line by line), not
 * only blank lines between paragraphs.
 */
export function Sanitized({
  markdown,
  resolveBlob,
  lineBreaks,
}: {
  markdown: string
  resolveBlob?: BlobResolver
  lineBreaks?: boolean
}) {
  const html = useMemo(
    () =>
      renderMarkdown(markdown, {
        ...(resolveBlob ? { resolveBlob } : {}),
        ...(lineBreaks ? { lineBreaks } : {}),
      }),
    [markdown, resolveBlob, lineBreaks],
  )
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
