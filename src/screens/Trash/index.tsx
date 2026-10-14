import { Trash2 } from 'lucide-react'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

export default function Trash() {
  const t = useT()
  return (
    <Screen title={t('common.trashTitle')} back={paths.settings}>
      <EmptyState icon={Trash2} title={t('common.trashEmpty')} />
    </Screen>
  )
}
