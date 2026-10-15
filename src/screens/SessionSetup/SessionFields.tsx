import { useId } from 'react'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { SessionKind } from '../../core/contracts/workspace'
import { SESSION_KINDS } from '../../core/srs/custom'
import { useT } from '../../i18n/react.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { KIND_HINT, KIND_SEGMENT } from '../Sessions/describe.ts'
import { parseLimit, type SessionDraft, scopeOptions, scopeValue, withKind } from './draft.ts'
import styles from './SessionSetup.module.css'

/** Where the cards come from, which ones, how many, and whether the answers count toward the schedule. */
export function SessionFields({ draft, onChange }: { draft: SessionDraft; onChange: (d: SessionDraft) => void }) {
  const t = useT()
  const scopeId = useId()
  const countsHintId = useId()
  const countsLabelId = useId()
  const options = useWorkspaceData(['courses', 'sections'], scopeOptions)
  const limitValid = parseLimit(draft.limit) !== null

  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={scopeId}>
          {t('review.sessionScope')}
        </label>
        <select
          id={scopeId}
          className={styles.select}
          value={scopeValue(draft.scope)}
          onChange={(e) => {
            const picked = options.find((o) => o.value === e.target.value)
            onChange({ ...draft, scope: picked?.scope ?? {} })
          }}
        >
          <option value="">{t('review.allCourses')}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <Segmented<SessionKind>
          label={t('review.sessionKind')}
          value={draft.kind}
          onChange={(kind) => onChange(withKind(draft, kind))}
          options={SESSION_KINDS.map((k) => ({ value: k, label: t(KIND_SEGMENT[k]) }))}
        />
        <p className={styles.hint} aria-live="polite">
          {t(KIND_HINT[draft.kind])}
        </p>
      </div>
      <Field
        label={t('review.sessionLimit')}
        hint={limitValid ? t('review.sessionLimitHint') : undefined}
        error={limitValid ? undefined : t('review.sessionLimitInvalid')}
        inputMode="numeric"
        enterKeyHint="done"
        autoComplete="off"
        value={draft.limit}
        onChange={(e) => onChange({ ...draft, limit: e.target.value })}
      />
      <label className={styles.switchRow}>
        <span className={styles.switchText}>
          <span id={countsLabelId} className={styles.switchLabel}>
            {t('review.countsInSchedule')}
          </span>
          <span id={countsHintId} className={styles.hint}>
            {draft.practice ? t('review.countsHintOff') : t('review.countsHintOn')}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className={styles.switch}
          checked={!draft.practice}
          aria-checked={!draft.practice}
          aria-labelledby={countsLabelId}
          aria-describedby={countsHintId}
          onChange={(e) => onChange({ ...draft, practice: !e.target.checked, practiceSet: true })}
        />
      </label>
    </>
  )
}
