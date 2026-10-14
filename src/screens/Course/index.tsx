import { FileText, Layers, NotebookText } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { CourseDot, courseHue } from '../../ui/components/Badges.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import NotFound from '../NotFound/index.tsx'

type Tab = 'cards' | 'sources' | 'fiches'

export default function Course() {
  const t = useT()
  const { id = '' } = useParams<{ id: string }>()
  const [tab, setTab] = useState<Tab>('cards')
  const data = useWorkspaceData(['courses', 'cards', 'sources', 'fiches'], (ws) => {
    const course = ws.courses.get(id)
    if (!course || course.deletedAt !== undefined) return null
    return {
      course,
      cards: ws.cards.list({ courseId: id }).map((c) => ({
        id: c.id,
        front: ws.text({ id: c.id, field: 'front' }).toString().split('\n')[0] ?? '',
      })),
      sources: ws.sources.list({ courseId: id }),
      fiches: ws.fiches.list({ courseId: id }),
    }
  })
  if (data === null) return <NotFound />
  const { course, cards, sources, fiches } = data

  return (
    <Screen title={course.title} back={paths.courses} trailing={<CourseDot hue={courseHue(course.color, course.id)} />}>
      <Segmented<Tab>
        label={t('common.courseTitle')}
        hideLabel
        value={tab}
        onChange={setTab}
        options={[
          { value: 'cards', label: t('course.tabCards') },
          { value: 'sources', label: t('course.tabSources') },
          { value: 'fiches', label: t('course.tabSheets') },
        ]}
      />
      {tab === 'cards' &&
        (cards.length === 0 ? (
          <EmptyState icon={Layers} title={t('course.noCards')} />
        ) : (
          <ListGroup title={t('course.tabCards')} hideTitle footer={t('course.cardCount', { count: cards.length })}>
            {cards.map((c) => (
              <ListRow key={c.id} href={to.card(c.id)} title={c.front || t('common.cardTitle')} />
            ))}
          </ListGroup>
        ))}
      {tab === 'sources' &&
        (sources.length === 0 ? (
          <EmptyState icon={FileText} title={t('course.noSources')} />
        ) : (
          <ListGroup title={t('course.tabSources')} hideTitle>
            {sources.map((s) => (
              <ListRow key={s.id} href={to.source(s.id)} leading={<FileText size={20} />} title={s.title} />
            ))}
          </ListGroup>
        ))}
      {tab === 'fiches' &&
        (fiches.length === 0 ? (
          <EmptyState icon={NotebookText} title={t('course.noSheets')} />
        ) : (
          <ListGroup title={t('course.tabSheets')} hideTitle>
            {fiches.map((f) => (
              <ListRow key={f.id} leading={<NotebookText size={20} />} title={f.title} />
            ))}
          </ListGroup>
        ))}
    </Screen>
  )
}
