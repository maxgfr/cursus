import { Smartphone } from 'lucide-react'
import { paths } from '../../../app/routes.ts'
import { useT } from '../../../i18n/react.tsx'
import { EmptyState } from '../../../ui/components/EmptyState.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'

export default function PairSettings() {
  const t = useT()
  return (
    <Screen title={t('sync.pairDevice')} back={paths.settings}>
      <EmptyState icon={Smartphone} title={t('sync.scanCode')} />
    </Screen>
  )
}
