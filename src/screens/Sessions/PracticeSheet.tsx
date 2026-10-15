import { Play, Settings2 } from 'lucide-react'
import { useLocation } from 'wouter'
import { paths, to, withScope } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { SessionKind, SessionScope } from '../../core/contracts/workspace'
import { sessionQueue } from '../../core/model/sessions'
import { useT } from '../../i18n/react.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { KIND_HINT, KIND_LABEL, practiceByDefault, scopeName } from './describe.ts'
import { PracticeChip } from './PracticeChip.tsx'

/** The quick choices, most common first: what is due, then everything, then the narrower sets. */
const QUICK: readonly SessionKind[] = ['due', 'all', 'new', 'failed', 'ahead']

/**
 * « Practice »: one tap starts a session over the course, the subset or every course, with no form to fill.
 * Each choice says how many cards it holds; the custom session stays one row away for the fine settings.
 */
export function PracticeSheet({ open, scope, onClose }: { open: boolean; scope: SessionScope; onClose: () => void }) {
  const t = useT()
  const ws = useWorkspace()
  const name = scopeName(ws, scope) ?? t('review.allCourses')
  return (
    <Sheet open={open} title={t('review.practiceScope', { scope: name })} onClose={onClose}>
      {/* Counted only while open: the choices are worked out when the student asks for them. */}
      {open && <Choices scope={scope} onClose={onClose} />}
    </Sheet>
  )
}

function Choices({ scope, onClose }: { scope: SessionScope; onClose: () => void }) {
  const t = useT()
  const ws = useWorkspace()
  const [, navigate] = useLocation()
  const { courseId, sectionId } = scope
  const counts = useWorkspaceData(['cards', 'courses', 'sections', 'reviews', 'prefs'], (w) => {
    const now = Date.now()
    const at: SessionScope = {
      ...(courseId !== undefined ? { courseId } : {}),
      ...(sectionId !== undefined ? { sectionId } : {}),
    }
    return QUICK.map((kind) => ({
      kind,
      count: sessionQueue(w, { scope: at, kind, practice: practiceByDefault(kind), now }).length,
    }))
  })
  const start = (kind: SessionKind) => {
    try {
      const id = ws.sessions.start({ scope, kind, practice: practiceByDefault(kind) })
      onClose()
      navigate(to.sessionRun(id), { state: { session: id } })
    } catch (e) {
      noteError('session.quickStart', e)
    }
  }

  return (
    <>
      <ListGroup title={t('review.practiceChoose')} hideTitle footer={t('review.practiceFooter')}>
        {counts.map(({ kind, count }) => (
          <ListRow
            key={kind}
            leading={<Play size={20} strokeWidth={1.75} />}
            title={
              <span>
                {t(KIND_LABEL[kind])} {practiceByDefault(kind) && <PracticeChip />}
              </span>
            }
            subtitle={
              count > 0 ? `${t('course.cardCount', { count })} · ${t(KIND_HINT[kind])}` : t('review.practiceNone')
            }
            {...(count > 0 ? { onClick: () => start(kind) } : {})}
          />
        ))}
      </ListGroup>
      <ListGroup>
        <ListRow
          leading={<Settings2 size={20} strokeWidth={1.75} />}
          title={t('review.customSession')}
          subtitle={t('review.newSessionBody')}
          onClick={() => {
            onClose()
            navigate(
              withScope(
                paths.sessionNew,
                courseId === undefined ? null : { courseId, ...(sectionId !== undefined ? { sectionId } : {}) },
              ),
            )
          }}
        />
      </ListGroup>
    </>
  )
}
