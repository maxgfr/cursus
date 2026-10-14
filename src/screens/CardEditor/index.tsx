import { History, Trash2 } from 'lucide-react'
import { Link, useLocation, useParams } from 'wouter'
import { to } from '../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { MarkdownEditor } from '../../ui/editor/MarkdownEditor.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import NotFound from '../NotFound/index.tsx'
import styles from './CardEditor.module.css'
import { ClozeAssistant } from './ClozeAssistant.tsx'

type Kind = 'basic' | 'cloze'

export default function CardEditor() {
  const t = useT()
  const ws = useWorkspace()
  const [, navigate] = useLocation()
  const { id = '' } = useParams<{ id: string }>()
  const card = useWorkspaceData(['cards', { id }], (w) => {
    const c = w.cards.get(id)
    if (!c || c.deletedAt !== undefined) return null
    return { card: c, front: w.text({ id: c.id, field: 'front' }).toString() }
  })
  if (card === null) return <NotFound />
  const { card: c, front } = card
  const frontText = ws.text({ id: c.id, field: 'front' })
  const remove = () => {
    ws.cards.trash(c.id)
    navigate(to.course(c.courseId))
  }
  return (
    <Screen title={t('common.cardTitle')} back={to.course(c.courseId)}>
      <Segmented<Kind>
        label={t('course.cardKind')}
        value={c.kind}
        onChange={(kind) => ws.cards.update(c.id, { kind })}
        options={[
          { value: 'basic', label: t('course.kindBasic') },
          { value: 'cloze', label: t('course.kindCloze') },
        ]}
      />
      <section className={styles.side} aria-labelledby="card-front">
        <h2 id="card-front" className={styles.label}>
          {c.kind === 'cloze' ? t('course.clozeText') : t('course.front')}
        </h2>
        <MarkdownEditor text={frontText} label={c.kind === 'cloze' ? t('course.clozeText') : t('course.front')} />
      </section>
      {c.kind === 'cloze' && <ClozeAssistant text={frontText} value={front} />}
      <section className={styles.side} aria-labelledby="card-back">
        <h2 id="card-back" className={styles.label}>
          {c.kind === 'cloze' ? t('course.extra') : t('course.back')}
        </h2>
        <MarkdownEditor
          text={ws.text({ id: c.id, field: 'back' })}
          label={c.kind === 'cloze' ? t('course.extra') : t('course.back')}
        />
      </section>
      <div className={styles.actions}>
        <Link href={to.history(c.id)} className={buttonClass({ variant: 'plain' })}>
          <History size={18} aria-hidden="true" />
          {t('course.history')}
        </Link>
        <Button variant="danger" icon={<Trash2 size={18} aria-hidden="true" />} onClick={remove}>
          {t('course.moveToTrash')}
        </Button>
      </div>
    </Screen>
  )
}
