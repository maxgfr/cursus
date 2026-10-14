import { useT } from '../../i18n/react.tsx'
import styles from './Today.module.css'

/** The exam that comes first and its share of today's queue. */
export interface Lead {
  title: string
  due: number
  days: number
}

/** "incl. 12 in Contracts · D-5" under Today's total; nothing when that exam has nothing due today. */
export function LeadLine({ lead }: { lead: Lead | null }) {
  const t = useT()
  if (lead === null || lead.due === 0) return null
  return (
    <p className={styles.examLead} data-testid="exam-lead">
      {t('today.examLead', {
        count: lead.due,
        course: lead.title,
        when: lead.days === 0 ? t('today.examToday') : t('today.examCountdown', { count: lead.days }),
      })}
    </p>
  )
}
