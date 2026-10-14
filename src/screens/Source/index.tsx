import { useParams } from 'wouter'
import { to } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { MarkdownEditor } from '../../ui/editor/MarkdownEditor.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import NotFound from '../NotFound/index.tsx'

export default function Source() {
  const t = useT()
  const ws = useWorkspace()
  const { id = '' } = useParams<{ id: string }>()
  const source = useWorkspaceData(['sources'], (w) => {
    const s = w.sources.get(id)
    return s && s.deletedAt === undefined ? s : null
  })
  if (source === null) return <NotFound />
  return (
    <Screen title={source.title} back={to.course(source.courseId)}>
      <MarkdownEditor
        text={ws.text({ id: source.id, field: 'body' })}
        label={t('common.sourceTitle')}
        placeholder={t('common.sourceEmpty')}
      />
    </Screen>
  )
}
