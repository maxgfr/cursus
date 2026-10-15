import { useId, useMemo } from 'react'
import { useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { SectionTree } from '../../core/model/sections'
import { useT } from '../../i18n/react.tsx'
import styles from './DeckImport.module.css'

/** A course, or one of its subsets: where an imported deck or its cards land. */
export interface Place {
  courseId: string
  /** '' for the course root. */
  sectionId: string
}

/** Indented "Contracts", "Contracts › Formation"… in tree order. */
function sectionOptions(tree: SectionTree, courseId: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = []
  const visit = (parentId: string | null, prefix: string) => {
    for (const s of tree.children(courseId, parentId)) {
      const label = prefix === '' ? s.name : `${prefix} › ${s.name}`
      out.push({ id: s.id, label })
      visit(s.id, label)
    }
  }
  visit(null, '')
  return out
}

/** Course and subset menus; the course menu is left out when `fixedCourse` (cards stay in the source's course). */
export function PlacePicker({
  value,
  onChange,
  courseLabel,
  sectionLabel,
  fixedCourse = false,
}: {
  value: Place
  onChange: (p: Place) => void
  courseLabel: string
  sectionLabel: string
  fixedCourse?: boolean
}) {
  const t = useT()
  const courseId = useId()
  const sectionId = useId()
  const courses = useWorkspaceData(['courses'], (ws) => ws.courses.list())
  const tree = useWorkspaceData(['sections'], (ws) => ws.sections.tree())
  const sections = useMemo(() => sectionOptions(tree, value.courseId), [tree, value.courseId])
  return (
    <>
      {!fixedCourse && courses.length > 0 && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={courseId}>
            {courseLabel}
          </label>
          <select
            id={courseId}
            className={styles.select}
            value={value.courseId}
            onChange={(e) => onChange({ courseId: e.target.value, sectionId: '' })}
          >
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
      )}
      {sections.length > 0 && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={sectionId}>
            {sectionLabel}
          </label>
          <select
            id={sectionId}
            className={styles.select}
            value={value.sectionId}
            onChange={(e) => onChange({ ...value, sectionId: e.target.value })}
          >
            <option value="">{t('ai.wholeCourse')}</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  )
}
