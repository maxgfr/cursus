import { Check, Undo2, X } from 'lucide-react'
import { useId } from 'react'
import { Link } from 'wouter'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import styles from './DraftReview.module.css'

export type ReviewStatus = 'pending' | 'accepted' | 'rejected'

/** One proposed question. `type` and `difficulty` are shown when known. */
export interface ReviewDraft {
  id: string
  kind: 'basic' | 'cloze'
  front: string
  back: string
  status: ReviewStatus
  type?: 'qa' | 'cloze' | 'explain'
  difficulty?: 'easy' | 'medium' | 'hard'
  /** Verbatim passage of the unit supporting the answer. */
  quote?: string
}

/** The drafts of one slide, page or section (or any other grouping: a source, a photo). */
export interface DraftGroup {
  key: string
  /** « Slide 12 », « Section 2.3 »: the citation, a link when `href` is set. */
  name: string
  title?: string
  /** Opens the cited unit in the Source viewer. */
  href?: string
  thumb?: { url: string; alt: string }
  drafts: readonly ReviewDraft[]
}

export interface DraftReviewProps {
  groups: readonly DraftGroup[]
  onAccept: (ids: readonly string[]) => void
  onReject: (ids: readonly string[]) => void
  /** Back to pending: undoes an accept or a reject. */
  onRestore: (ids: readonly string[]) => void
  onEdit: (id: string, patch: { front?: string; back?: string }) => void
  /** Heading level of each group's name (default 3). */
  level?: 2 | 3
}

/**
 * Proposed questions grouped by the unit they cite, with its picture beside them: accept all at once, all of
 * one unit, or one by one; edit; reject (undoable). Saving is the caller's explicit action.
 */
export function DraftReview({ groups, onAccept, onReject, onRestore, onEdit, level = 3 }: DraftReviewProps) {
  const t = useT()
  const all = groups.flatMap((g) => g.drafts)
  const pending = all.filter((d) => d.status === 'pending')
  const accepted = all.filter((d) => d.status === 'accepted').length
  return (
    <div className={styles.review}>
      <div className={styles.bar}>
        <p className={styles.counts} aria-live="polite">
          {t('ai.deckReviewCounts', { pending: pending.length, accepted })}
        </p>
        <Button
          icon={<Check size={18} aria-hidden="true" />}
          disabled={pending.length === 0}
          onClick={() => onAccept(pending.map((d) => d.id))}
        >
          {t('ai.deckAcceptAll')}
        </Button>
      </div>
      {groups.map((g) => (
        <Group
          key={g.key}
          group={g}
          level={level}
          onAccept={onAccept}
          onReject={onReject}
          onRestore={onRestore}
          onEdit={onEdit}
        />
      ))}
    </div>
  )
}

function Group({
  group,
  level,
  onAccept,
  onReject,
  onRestore,
  onEdit,
}: Omit<DraftReviewProps, 'groups'> & { group: DraftGroup; level: 2 | 3 }) {
  const t = useT()
  const headingId = useId()
  const Heading = level === 2 ? 'h2' : 'h3'
  const pending = group.drafts.filter((d) => d.status === 'pending').map((d) => d.id)
  return (
    <section className={styles.group} aria-labelledby={headingId}>
      <div className={styles.groupHead}>
        {group.thumb && (
          <div className={styles.thumb}>
            <img src={group.thumb.url} alt={group.thumb.alt} />
          </div>
        )}
        <Heading id={headingId} className={styles.groupName}>
          {group.href ? (
            <Link href={group.href} className={styles.cite}>
              {group.name}
            </Link>
          ) : (
            <span className={styles.cite}>{group.name}</span>
          )}
          {group.title && (
            <>
              {' '}
              <span className={styles.groupTitle}>{group.title}</span>
            </>
          )}
        </Heading>
        {pending.length > 0 && (
          <Button
            variant="plain"
            icon={<Check size={18} aria-hidden="true" />}
            aria-label={t('ai.deckAcceptGroupFull', { name: group.name })}
            onClick={() => onAccept(pending)}
          >
            {t('ai.deckAcceptGroup')}
          </Button>
        )}
      </div>
      <ol className={styles.drafts}>
        {group.drafts.map((d, i) => (
          <DraftItem
            key={d.id}
            draft={d}
            n={i + 1}
            unit={group.name}
            onAccept={onAccept}
            onReject={onReject}
            onRestore={onRestore}
            onEdit={onEdit}
          />
        ))}
      </ol>
    </section>
  )
}

function DraftItem({
  draft,
  n,
  unit,
  onAccept,
  onReject,
  onRestore,
  onEdit,
}: Omit<DraftReviewProps, 'groups'> & { draft: ReviewDraft; n: number; unit: string }) {
  const t = useT()
  const id = useId()
  const where = t('ai.deckWhere', { n, name: unit })
  if (draft.status === 'rejected') {
    return (
      <li className={styles.rejected}>
        <p className={styles.rejectedText}>
          <span className={styles.rejectedLabel}>{t('ai.deckRejected')}</span> {draft.front}
        </p>
        <Button
          variant="plain"
          icon={<Undo2 size={18} aria-hidden="true" />}
          aria-label={t('ai.deckUndoOne', { n, name: unit })}
          onClick={() => onRestore([draft.id])}
        >
          {t('ai.deckUndoReject')}
        </Button>
      </li>
    )
  }
  const accepted = draft.status === 'accepted'
  return (
    <li className={styles.draft} data-status={draft.status}>
      <div className={styles.badges}>
        {draft.type && <span className={styles.badge}>{typeLabel(t, draft.type)}</span>}
        {draft.difficulty && <span className={styles.badge}>{difficultyLabel(t, draft.difficulty)}</span>}
        {accepted && (
          <span className={styles.badgeGood}>
            <Check size={14} aria-hidden="true" />
            {t('ai.deckAccepted')}
          </span>
        )}
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-f`}>
          {draft.kind === 'cloze' ? t('ai.deckClozeText') : t('ai.deckQuestion')}
          <span className="sr-only"> {where}</span>
        </label>
        <textarea
          id={`${id}-f`}
          className={styles.textarea}
          rows={2}
          value={draft.front}
          onChange={(e) => onEdit(draft.id, { front: e.target.value })}
        />
      </div>
      {draft.kind === 'basic' && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-b`}>
            {t('ai.deckAnswer')}
            <span className="sr-only"> {where}</span>
          </label>
          <textarea
            id={`${id}-b`}
            className={styles.textarea}
            rows={2}
            value={draft.back}
            onChange={(e) => onEdit(draft.id, { back: e.target.value })}
          />
        </div>
      )}
      {draft.quote && <p className={styles.quote}>{t('ai.deckQuote', { quote: draft.quote })}</p>}
      <div className={styles.actions}>
        <Button
          variant={accepted ? 'secondary' : 'primary'}
          icon={<Check size={18} aria-hidden="true" />}
          aria-pressed={accepted}
          aria-label={t('ai.deckAcceptOne', { n, name: unit })}
          onClick={() => (accepted ? onRestore([draft.id]) : onAccept([draft.id]))}
        >
          {t('ai.deckAccept')}
        </Button>
        <Button
          variant="plain"
          icon={<X size={18} aria-hidden="true" />}
          aria-label={t('ai.deckRejectOne', { n, name: unit })}
          onClick={() => onReject([draft.id])}
        >
          {t('ai.deckReject')}
        </Button>
      </div>
    </li>
  )
}

type T = ReturnType<typeof useT>

function typeLabel(t: T, type: NonNullable<ReviewDraft['type']>): string {
  if (type === 'cloze') return t('ai.deckTypeCloze')
  if (type === 'explain') return t('ai.deckTypeExplain')
  return t('ai.deckTypeQa')
}

function difficultyLabel(t: T, d: NonNullable<ReviewDraft['difficulty']>): string {
  if (d === 'easy') return t('ai.deckEasy')
  if (d === 'hard') return t('ai.deckHard')
  return t('ai.deckMedium')
}
