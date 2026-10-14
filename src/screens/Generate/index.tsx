import { Sparkles } from 'lucide-react'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

export default function Generate() {
  const t = useT()
  return (
    <Screen title={t('ai.generate')} back={paths.understand}>
      <EmptyState icon={Sparkles} title={t('common.generateBody')} />
    </Screen>
  )
}
