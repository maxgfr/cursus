import { useWorkspaceData } from '../app/workspaceContext.tsx'
import type { Id } from '../core/contracts/workspace'
import { useT } from '../i18n/react.tsx'
import { Sheet } from './components/Sheet.tsx'
import { Sanitized } from './render/Sanitized.tsx'

export interface FicheSheetProps {
  /** The study sheet shown; null closes the sheet. */
  ficheId: Id | null
  onClose: () => void
}

/** A study sheet, read only, through the sanitised renderer. Loaded on demand. */
export default function FicheSheet({ ficheId, onClose }: FicheSheetProps) {
  const t = useT()
  const fiche = useWorkspaceData(['fiches', { id: ficheId ?? '' }], (w) => {
    const f = ficheId === null ? undefined : w.fiches.get(ficheId)
    return f ? { title: f.title, body: w.text({ id: f.id, field: 'body' }).toString() } : null
  })
  return (
    <Sheet open={fiche !== null} title={fiche?.title ?? t('course.tabSheets')} onClose={onClose}>
      {fiche && (fiche.body.trim() === '' ? <p>{t('course.emptySheet')}</p> : <Sanitized markdown={fiche.body} />)}
    </Sheet>
  )
}
