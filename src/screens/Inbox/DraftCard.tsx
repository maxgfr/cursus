import { Check, Pencil, X } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { clozeFaces } from '../../core/model/cloze'
import type { Draft } from '../../core/model/drafts'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { MarkdownEditor } from '../../ui/editor/MarkdownEditor.tsx'
import { Sanitized } from '../../ui/render/Sanitized.tsx'
import { useBlobResolver } from '../Photos/files.ts'
import styles from './Inbox.module.css'

const HAS_CLOZE = /\{\{c\d+::.+?\}\}/s

/** A cloze card's text as a preview: every deletion marked, as its review shows the answer. */
const shown = (d: Pick<Draft, 'kind'>, text: string) => (d.kind === 'cloze' ? clozeFaces(text, 0).back : text)

export interface DraftCardProps {
  draft: Draft
  /** « Card 2 of Slide 3 »: the card's place, for the buttons' accessible names. */
  where: string
  /** The card the arrows land on (the one with `tabIndex` 0). */
  current: boolean
  editing: boolean
  onFocus(): void
  onAdd(edit?: { front: string; back: string }): void
  onReject(): void
  onEdit(on: boolean): void
}

/**
 * One suggested card: its question and answer as they will read in review (maths, photos, cloze), the answer
 * folded; Add, Edit (in the editor, then Add) and Reject. Keys on the focused card: A, E, R (or Delete).
 */
export function DraftCard({ draft, where, current, editing, onFocus, onAdd, onReject, onEdit }: DraftCardProps) {
  const t = useT()
  const id = useId()
  const resolve = useBlobResolver(`${draft.front}\n${draft.back}`)
  const label = draft.kind === 'cloze' ? t('ai.deckClozeText') : t('ai.deckQuestion')
  const backLabel = draft.kind === 'cloze' ? t('course.extra') : t('ai.deckAnswer')
  return (
    <li className={styles.item}>
      <article
        className={styles.card}
        data-draft={draft.id}
        aria-labelledby={`${id}-q`}
        tabIndex={current ? 0 : -1}
        onFocus={onFocus}
      >
        <div className={styles.badges}>
          <span className={styles.badge}>{typeLabel(t, draft.type)}</span>
          {draft.difficulty && <span className={styles.badge}>{difficultyLabel(t, draft.difficulty)}</span>}
        </div>
        {editing ? (
          <Editing draft={draft} label={label} backLabel={backLabel} onAdd={onAdd} onCancel={() => onEdit(false)} />
        ) : (
          <>
            <div id={`${id}-q`} className={styles.front}>
              <span className="sr-only">{label}: </span>
              <Sanitized markdown={shown(draft, draft.front)} resolveBlob={resolve ?? undefined} />
            </div>
            {draft.back.trim() !== '' && (
              <details className={styles.back}>
                <summary className={styles.backSummary}>{backLabel}</summary>
                <Sanitized markdown={draft.back} resolveBlob={resolve ?? undefined} />
              </details>
            )}
            {draft.quote && <p className={styles.quote}>{t('ai.deckQuote', { quote: draft.quote })}</p>}
            <div className={styles.actions}>
              <Button
                variant="primary"
                icon={<Check size={18} aria-hidden="true" />}
                aria-label={t('ai.inboxAddOne', { where })}
                aria-keyshortcuts="A"
                onClick={() => onAdd()}
              >
                {t('ai.inboxAdd')}
              </Button>
              <Button
                variant="secondary"
                icon={<Pencil size={18} aria-hidden="true" />}
                aria-label={t('ai.inboxEditOne', { where })}
                aria-keyshortcuts="E"
                onClick={() => onEdit(true)}
              >
                {t('ai.inboxEdit')}
              </Button>
              <Button
                variant="plain"
                icon={<X size={18} aria-hidden="true" />}
                aria-label={t('ai.inboxRejectOne', { where })}
                aria-keyshortcuts="R Delete"
                onClick={onReject}
              >
                {t('ai.inboxReject')}
              </Button>
            </div>
          </>
        )}
      </article>
    </li>
  )
}

/** The card in the editor (a scratch text: the suggestion changes only when it is added). */
function Editing({
  draft,
  label,
  backLabel,
  onAdd,
  onCancel,
}: {
  draft: Draft
  label: string
  backLabel: string
  onAdd(edit: { front: string; back: string }): void
  onCancel(): void
}) {
  const t = useT()
  const texts = useMemo(() => {
    const doc = new Y.Doc()
    const front = doc.getText('front')
    const back = doc.getText('back')
    front.insert(0, draft.front)
    back.insert(0, draft.back)
    return { front, back }
  }, [draft.front, draft.back])
  const [invalid, setInvalid] = useState(false)
  const add = () => {
    const front = texts.front.toString().trim()
    const back = texts.back.toString().trim()
    if (front === '' || (draft.kind === 'cloze' && !HAS_CLOZE.test(front))) {
      setInvalid(true)
      return
    }
    onAdd({ front, back })
  }
  return (
    <div className={styles.editing}>
      <MarkdownEditor text={texts.front} label={label} cloze={draft.kind === 'cloze'} />
      <MarkdownEditor text={texts.back} label={backLabel} />
      {invalid && (
        <p className={styles.error} role="alert">
          {t('ai.inboxInvalid')}
        </p>
      )}
      <div className={styles.actions}>
        <Button variant="primary" icon={<Check size={18} aria-hidden="true" />} onClick={add}>
          {t('ai.inboxAdd')}
        </Button>
        <Button variant="plain" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}

type T = ReturnType<typeof useT>

function typeLabel(t: T, type: Draft['type']): string {
  if (type === 'cloze') return t('ai.deckTypeCloze')
  if (type === 'explain') return t('ai.deckTypeExplain')
  return t('ai.deckTypeQa')
}

function difficultyLabel(t: T, d: NonNullable<Draft['difficulty']>): string {
  if (d === 'easy') return t('ai.deckEasy')
  if (d === 'hard') return t('ai.deckHard')
  return t('ai.deckMedium')
}
