import { Check, Pencil, X } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import * as Y from 'yjs'
import type { StudyScope } from '../../core/contracts/workspace'
import { clozeFaces } from '../../core/model/cloze'
import type { Draft } from '../../core/model/drafts'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { MarkdownEditor } from '../../ui/editor/MarkdownEditor.tsx'
import { Sanitized } from '../../ui/render/Sanitized.tsx'
import { ClozePreview } from '../CardEditor/ClozePreview.tsx'
import { applyForward } from '../History/replay.ts'
import CardPhotos from '../Photos/CardPhotos.tsx'
import { useBlobResolver } from '../Photos/files.ts'
import styles from './Inbox.module.css'

const HAS_CLOZE = /\{\{c\d+::.+?\}\}/s

/** A cloze card's text as a preview: every deletion marked, as its review shows the answer. */
const shown = (d: Pick<Draft, 'kind'>, text: string) => (d.kind === 'cloze' ? clozeFaces(text, 0).back : text)

/** A suggestion as changed in the editor before it is added: its text, and its kind (with the matching type). */
export interface DraftCardEdit {
  front: string
  back: string
  kind: Draft['kind']
  type: Draft['type']
}

export interface DraftCardProps {
  draft: Draft
  /** « Card 2 of Slide 3 »: the card's place, for the buttons' accessible names. */
  where: string
  /** The card the arrows land on (the one with `tabIndex` 0). */
  current: boolean
  editing: boolean
  /** Where the card will go once added: photos taken in the editor are kept there too. */
  place: StudyScope
  onFocus(): void
  onAdd(edit?: DraftCardEdit): void
  onReject(): void
  onEdit(on: boolean): void
}

/**
 * One suggested card: its question and answer as they will read in review (maths, photos, cloze), the answer
 * folded; Add, Edit (in the editor, then Add) and Reject. Keys on the focused card: A, E, R (or Delete).
 */
export function DraftCard({ draft, where, current, editing, place, onFocus, onAdd, onReject, onEdit }: DraftCardProps) {
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
          <Editing draft={draft} place={place} onAdd={onAdd} onCancel={() => onEdit(false)} />
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

/**
 * The card in the editor, as a new card is written in the card editor: its kind, both sides with their photos (taken,
 * picked among the course's, removed), the blanks to tap for a cloze. A scratch text: the suggestion changes only when
 * it is added.
 */
function Editing({
  draft,
  place,
  onAdd,
  onCancel,
}: {
  draft: Draft
  place: StudyScope
  onAdd(edit: DraftCardEdit): void
  onCancel(): void
}) {
  const t = useT()
  const texts = useMemo(() => {
    const doc = new Y.Doc()
    const front = doc.getText('front')
    const back = doc.getText('back')
    front.insert(0, draft.front)
    back.insert(0, draft.back)
    return { doc, front, back }
  }, [draft.front, draft.back])
  const [kind, setKind] = useState<Draft['kind']>(draft.kind)
  const [values, setValues] = useState({ front: draft.front, back: draft.back })
  useEffect(() => {
    const update = () => setValues({ front: texts.front.toString(), back: texts.back.toString() })
    update()
    texts.doc.on('update', update)
    return () => texts.doc.off('update', update)
  }, [texts])
  const [invalid, setInvalid] = useState(false)
  const label = kind === 'cloze' ? t('ai.deckClozeText') : t('ai.deckQuestion')
  const backLabel = kind === 'cloze' ? t('course.extra') : t('ai.deckAnswer')
  const photos = place.sectionId === undefined ? { courseId: place.courseId } : place
  const add = () => {
    const front = texts.front.toString().trim()
    const back = texts.back.toString().trim()
    if (front === '' || (kind === 'cloze' && !HAS_CLOZE.test(front))) {
      setInvalid(true)
      return
    }
    // The type follows the kind: a basic card is no fill-in-the-blank, a cloze is one.
    const type =
      kind === draft.kind ? draft.type : kind === 'cloze' ? 'cloze' : draft.type === 'cloze' ? 'qa' : draft.type
    onAdd({ front, back, kind, type })
  }
  return (
    <div className={styles.editing}>
      <Segmented<Draft['kind']>
        label={t('course.cardKind')}
        value={kind}
        onChange={(k) => {
          setKind(k)
          setInvalid(false)
        }}
        options={[
          { value: 'basic', label: t('course.kindBasic') },
          { value: 'cloze', label: t('course.kindCloze') },
        ]}
      />
      <MarkdownEditor text={texts.front} label={label} cloze={kind === 'cloze'} photos={photos} />
      <CardPhotos text={texts.front} value={values.front} {...photos} side={label} />
      {kind === 'cloze' && <ClozePreview value={values.front} onChange={(next) => applyForward(texts.front, next)} />}
      <MarkdownEditor text={texts.back} label={backLabel} photos={photos} />
      <CardPhotos text={texts.back} value={values.back} {...photos} side={backLabel} />
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
