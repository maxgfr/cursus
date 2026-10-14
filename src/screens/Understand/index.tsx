import { Lightbulb, ListChecks, Sparkles } from 'lucide-react'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

export default function Understand() {
  const t = useT()
  return (
    <Screen title={t('ai.understand')}>
      <EmptyState icon={Lightbulb} title={t('ai.explainPrompt')} body={t('common.understandBody')} />
      <ListGroup title={t('common.more')} hideTitle>
        <ListRow href={paths.generate} leading={<Sparkles size={20} />} title={t('ai.generate')} />
        <ListRow href={paths.quiz} leading={<ListChecks size={20} />} title={t('ai.quiz')} />
      </ListGroup>
    </Screen>
  )
}
