import { LifeBuoy } from 'lucide-react'
import { paths } from '../../../app/routes.ts'
import { useT } from '../../../i18n/react.tsx'
import { EmptyState } from '../../../ui/components/EmptyState.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'

export default function RecoverySettings() {
  const t = useT()
  return (
    <Screen title={t('common.setRecovery')} back={paths.settings}>
      <EmptyState icon={LifeBuoy} title={t('common.recoveryBody')} />
    </Screen>
  )
}
