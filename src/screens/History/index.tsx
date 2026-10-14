import { History as HistoryIcon } from 'lucide-react'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

export default function History() {
  const t = useT()
  return (
    <Screen title={t('common.historyTitle')} back={paths.courses}>
      <EmptyState icon={HistoryIcon} title={t('common.historyEmpty')} />
    </Screen>
  )
}
