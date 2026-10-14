import { useParams } from 'wouter'
import { CourseView } from './View.tsx'

export type { CardNotice } from './View.tsx'

/** A course's root: its sections, then the cards, sources and study sheets filed directly in it. */
export default function Course() {
  const { id = '' } = useParams<{ id: string }>()
  return <CourseView key={id} courseId={id} />
}
