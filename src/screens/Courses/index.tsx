import { BookOpen } from 'lucide-react'
import { to } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { CountPill, CourseDot } from '../../ui/components/Badges.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { useStudy } from '../../ui/data/useStudy.ts'
import { Screen } from '../../ui/shell/Screen.tsx'

export default function Courses() {
  const t = useT()
  const { courses } = useStudy()
  return (
    <Screen title={t('common.navCourses')}>
      {courses.length === 0 ? (
        <EmptyState icon={BookOpen} title={t('today.noCourses')} />
      ) : (
        <ListGroup title={t('common.navCourses')} hideTitle>
          {courses.map((c) => (
            <ListRow
              key={c.id}
              href={to.course(c.id)}
              leading={<CourseDot hue={c.hue} />}
              title={c.title}
              subtitle={t('course.cardCount', { count: c.total })}
              trailing={<CountPill count={c.due} label={t('common.dueBadge', { count: c.due })} />}
            />
          ))}
        </ListGroup>
      )}
    </Screen>
  )
}
