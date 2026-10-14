import { BookOpen, Plus } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { ListGroup } from '../../ui/components/List.tsx'
import { useStudy } from '../../ui/data/useStudy.ts'
import { Screen } from '../../ui/shell/Screen.tsx'
import { CourseRows } from '../Today/CourseRows.tsx'
import { NewCourseSheet } from '../Today/NewCourseSheet.tsx'

export default function Courses() {
  const t = useT()
  const { courses } = useStudy()
  const [adding, setAdding] = useState(false)
  return (
    <Screen
      title={t('common.navCourses')}
      trailing={<IconButton icon={Plus} label={t('today.addCourse')} onClick={() => setAdding(true)} />}
    >
      <NewCourseSheet open={adding} onClose={() => setAdding(false)} />
      {courses.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={t('today.noCourses')}
          action={
            <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setAdding(true)}>
              {t('today.addCourse')}
            </Button>
          }
        />
      ) : (
        <ListGroup title={t('common.navCourses')} hideTitle>
          <CourseRows courses={courses} />
        </ListGroup>
      )}
    </Screen>
  )
}
