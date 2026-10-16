import type { ReactNode } from 'react'
import { to } from '../../app/routes.ts'
import { type ChatSegment, guardReply } from '../../core/ai/features/tutorChat'
import type { SourceRef } from '../../core/ai/schemas'
import { useT } from '../../i18n/react.tsx'
import { Citation } from '../../screens/Understand/shared/SourcePicker.tsx'
import { Sanitized } from '../render/Sanitized.tsx'
import styles from './ChatPanel.module.css'
import type { ScreenContext } from './context.tsx'

/** A cited passage's address: the source, at its page, slide or section when there is one. */
const citeHref = (ref: SourceRef) =>
  ref.page === undefined ? to.source(ref.sourceId) : `${to.source(ref.sourceId)}?page=${ref.page}`

/**
 * The answer as Markdown, its citations numbered in order of first use (`[1]` links to the passage, the sources
 * are listed by name below). A streamed answer ends with a cursor.
 */
function answerMarkdown(segments: readonly ChatSegment[], streaming: boolean): { markdown: string; refs: SourceRef[] } {
  const order = new Map<string, number>()
  const refs: SourceRef[] = []
  let markdown = ''
  for (const s of segments) {
    if (s.kind === 'text') {
      markdown += s.text
      continue
    }
    const key = `${s.ref.sourceId}\u0000${s.ref.page ?? ''}`
    let n = order.get(key)
    if (n === undefined) {
      refs.push(s.ref)
      n = refs.length
      order.set(key, n)
    }
    markdown += ` [${n}](#${citeHref(s.ref)})`
  }
  return { markdown: streaming && markdown !== '' ? `${markdown} ▍` : markdown, refs }
}

export function Answer({
  segments,
  card,
  streaming = false,
  children,
}: {
  segments: ChatSegment[]
  card: ScreenContext['card']
  streaming?: boolean
  children?: ReactNode
}) {
  const t = useT()
  const guarded = guardReply(segments, card)
  const { markdown, refs } = answerMarkdown(guarded.segments, streaming)
  return (
    <div className={styles.answer}>
      <span className="sr-only">{t('chat.tutor')}: </span>
      {markdown !== '' && (
        <div className={styles.answerText}>
          <Sanitized markdown={markdown} />
        </div>
      )}
      {refs.length > 0 && (
        <ol className={styles.sources} aria-label={t('chat.sources')}>
          {refs.map((ref, i) => (
            <li key={`${ref.sourceId}/${ref.page ?? ''}`} className={styles.source}>
              <span className={styles.sourceNumber} aria-hidden="true">
                {i + 1}
              </span>
              <Citation sourceRef={ref} />
            </li>
          ))}
        </ol>
      )}
      {guarded.leaked && <p className={styles.note}>{t('chat.hidden')}</p>}
      {children}
    </div>
  )
}
