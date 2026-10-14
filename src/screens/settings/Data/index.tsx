import { Database } from 'lucide-react'
import { paths } from '../../../app/routes.ts'
import { useT } from '../../../i18n/react.tsx'
import { EmptyState } from '../../../ui/components/EmptyState.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'

export default function DataSettings() {
  const t = useT()
  return (
    <Screen title={t('common.setData')} back={paths.settings}>
      <EmptyState icon={Database} title={t('common.dataBody')} />
    </Screen>
  )
}
