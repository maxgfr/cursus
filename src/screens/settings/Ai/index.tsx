import { Sparkles } from 'lucide-react'
import { paths } from '../../../app/routes.ts'
import { useT } from '../../../i18n/react.tsx'
import { EmptyState } from '../../../ui/components/EmptyState.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'

export default function AiSettings() {
  const t = useT()
  return (
    <Screen title={t('common.setAi')} back={paths.settings}>
      <EmptyState icon={Sparkles} title={t('ai.noKey')} />
    </Screen>
  )
}
