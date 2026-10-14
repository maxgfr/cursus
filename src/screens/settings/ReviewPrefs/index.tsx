import { CalendarCheck } from 'lucide-react'
import { paths } from '../../../app/routes.ts'
import { useT } from '../../../i18n/react.tsx'
import { EmptyState } from '../../../ui/components/EmptyState.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'

export default function ReviewPrefsSettings() {
  const t = useT()
  return (
    <Screen title={t('common.setReview')} back={paths.settings}>
      <EmptyState icon={CalendarCheck} title={t('common.reviewPrefsBody')} />
    </Screen>
  )
}
