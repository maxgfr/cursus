import { History } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation } from 'wouter'
import { leaveTo } from '../../app/nav.ts'
import { paths, to, withScope } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { SessionScope } from '../../core/contracts/workspace'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { useScopeOnce } from '../Section/scope.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { draftLimit, liveScope, newDraft, scopeOptions, useSessionPreview } from './draft.ts'
import { SessionFields } from './SessionFields.tsx'
import styles from './SessionSetup.module.css'

const asStudyScope = (s: SessionScope) =>
  s.courseId === undefined
    ? null
    : s.sectionId === undefined
      ? { courseId: s.courseId }
      : { courseId: s.courseId, sectionId: s.sectionId }

/** "New session": scope, type, card count and whether it counts toward the schedule, with a live count. */
export default function SessionSetup() {
  const t = useT()
  const ws = useWorkspace()
  const [, navigate] = useLocation()
  const asked = useScopeOnce()
  const options = useWorkspaceData(['courses', 'sections'], scopeOptions)
  const [draft, setDraft] = useState(() => newDraft(liveScope(options, asked ?? {})))
  const [error, setError] = useState<string | null>(null)
  const count = useSessionPreview(draft)
  const limit = draftLimit(draft)
  const from = asStudyScope(asked ?? {})
  const back = from === null ? paths.sessions : to.place(from.courseId, from.sectionId)

  const start = () => {
    if (limit === null || count === null || count === 0) return
    try {
      const id = ws.sessions.start({ scope: draft.scope, kind: draft.kind, limit, practice: draft.practice })
      // The run takes this screen's place; its history state lets leaving go back to where it was set up from.
      navigate(to.sessionRun(id), { replace: true, state: { session: id } })
    } catch (e) {
      noteError('session.start', e)
      setError(t('review.sessionFailed'))
    }
  }

  return (
    <Screen
      title={t('review.newSession')}
      back={back}
      trailing={<IconButton icon={History} label={t('review.sessions')} onClick={() => leaveTo(paths.sessions)} />}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault()
          start()
        }}
      >
        <SessionFields draft={draft} onChange={setDraft} />
        <p
          className={count === 0 ? `${styles.preview} ${styles.previewNone}` : styles.preview}
          role="status"
          data-testid="session-preview"
        >
          {count === null ? ' ' : count === 0 ? t('review.sessionPreviewNone') : t('review.sessionPreview', { count })}
        </p>
        <div className={styles.actions}>
          <Button type="submit" variant="primary" size="large" full disabled={count === null || count === 0}>
            {t('review.startSession')}
          </Button>
        </div>
        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </form>
      <p>
        <Link href={withScope(to.sessionPlan('new'), asStudyScope(draft.scope))} className={styles.link}>
          {t('review.planSession')}
        </Link>
      </p>
    </Screen>
  )
}
