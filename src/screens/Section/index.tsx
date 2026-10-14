import { useParams } from 'wouter'
import { CourseView } from '../Course/View.tsx'

/** One subset of a course: its own sections first, then its items; Start and Understand cover its descendants. */
export default function Section() {
  const { id = '', sectionId = '' } = useParams<{ id: string; sectionId: string }>()
  return <CourseView key={sectionId} courseId={id} sectionId={sectionId} />
}
