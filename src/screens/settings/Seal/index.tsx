import { ShieldCheck } from 'lucide-react'
import { paths } from '../../../app/routes.ts'
import { useT } from '../../../i18n/react.tsx'
import { EmptyState } from '../../../ui/components/EmptyState.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'

export default function SealSettings() {
  const t = useT()
  return (
    <Screen title={t('common.setSeal')} back={paths.settings}>
      <EmptyState icon={ShieldCheck} title={t('common.sealBody')} />
    </Screen>
  )
}
