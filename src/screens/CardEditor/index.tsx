import { useParams } from 'wouter'
import { to } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { MarkdownEditor } from '../../ui/editor/MarkdownEditor.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import NotFound from '../NotFound/index.tsx'
import styles from './CardEditor.module.css'

export default function CardEditor() {
  const t = useT()
  const ws = useWorkspace()
  const { id = '' } = useParams<{ id: string }>()
  const card = useWorkspaceData(['cards'], (w) => {
    const c = w.cards.get(id)
    return c && c.deletedAt === undefined ? c : null
  })
  if (card === null) return <NotFound />
  return (
    <Screen title={t('common.cardTitle')} back={to.course(card.courseId)}>
      <section className={styles.side} aria-labelledby="card-front">
        <h2 id="card-front" className={styles.label}>
          {t('course.front')}
        </h2>
        <MarkdownEditor text={ws.text({ id: card.id, field: 'front' })} label={t('course.front')} />
      </section>
      <section className={styles.side} aria-labelledby="card-back">
        <h2 id="card-back" className={styles.label}>
          {t('course.back')}
        </h2>
        <MarkdownEditor text={ws.text({ id: card.id, field: 'back' })} label={t('course.back')} />
      </section>
    </Screen>
  )
}
