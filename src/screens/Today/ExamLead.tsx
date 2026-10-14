import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import { type Lead, LeadLine } from './LeadLine.tsx'
import { sectionExamLead } from './sectionLead.ts'

/** A chapter exam that comes first is named instead of its course's (same sentence, same place). */
export default function ExamLead({ course }: { course: Lead | null }) {
  const section = useWorkspaceData(['courses', 'sections', 'cards', 'reviews', 'prefs'], (ws) =>
    sectionExamLead(ws, Date.now()),
  )
  return <LeadLine lead={section ?? course} />
}
