import { ChartColumn } from 'lucide-react'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

export default function Stats() {
  const t = useT()
  return (
    <Screen title={t('common.statsTitle')} back={paths.settings}>
      <EmptyState icon={ChartColumn} title={t('common.statsEmpty')} />
    </Screen>
  )
}
