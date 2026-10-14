import { ListChecks } from 'lucide-react'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

export default function Quiz() {
  const t = useT()
  return (
    <Screen title={t('ai.quiz')} back={paths.understand}>
      <EmptyState icon={ListChecks} title={t('common.quizBody')} />
    </Screen>
  )
}
