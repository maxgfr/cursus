import { FileText } from 'lucide-react'
import { paths } from '../../../app/routes.ts'
import { useT } from '../../../i18n/react.tsx'
import { EmptyState } from '../../../ui/components/EmptyState.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'

export default function DiagnosticSettings() {
  const t = useT()
  return (
    <Screen title={t('common.setDiagnostic')} back={paths.settings}>
      <EmptyState icon={FileText} title={t('common.diagnosticBody')} />
    </Screen>
  )
}
