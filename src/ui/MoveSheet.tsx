import { Folder } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useWorkspaceData } from '../app/workspaceContext.tsx'
import type { Id, ItemKind } from '../core/contracts/workspace'
import { SectionMoveError, type SectionTree } from '../core/model/sections'
import type { ModelWorkspace } from '../core/model/workspace'
import { useT } from '../i18n/react.tsx'
import { CourseDot, type CourseHue, courseHue } from './components/Badges.tsx'
import { Sheet } from './components/Sheet.tsx'
import styles from './MoveSheet.module.css'

/** A place an item or a section can go: a course root (sectionId null) or one of its sections. */
export interface Place {
  courseId: Id
  sectionId: Id | null
}

interface Node {
  place: Place
  label: string
  /** Course › Section › …, for the confirmation. */
  path: string
  hue?: CourseHue
  children: Node[]
}

function sectionNodes(tree: SectionTree, courseId: Id, parentId: Id | null, prefix: string): Node[] {
  return tree.children(courseId, parentId).map((s) => {
    const path = `${prefix} › ${s.name}`
    return {
      place: { courseId, sectionId: s.id },
      label: s.name,
      path,
      children: sectionNodes(tree, courseId, s.id, path),
    }
  })
}

/** Moves a source, card or study sheet to a place, in its course or another one. */
export function moveItemTo(ws: ModelWorkspace, kind: ItemKind, id: Id, to: Place): void {
  if (to.sectionId !== null) ws.moveItem(kind, id, to.sectionId)
  else if (ws[kind].get(id)?.courseId === to.courseId) ws.moveItem(kind, id, null)
  else if (kind === 'cards') ws.cards.move(id, to.courseId)
  else if (kind === 'sources') ws.sources.update(id, { courseId: to.courseId, sectionId: undefined })
  else ws.fiches.update(id, { courseId: to.courseId, sectionId: undefined })
}

export interface MoveSheetProps {
  open: boolean
  title: string
  onClose: () => void
  /** Where the thing is now: marked in the tree. */
  current: Place
  /** Only this course is offered (a section never changes course). */
  courseOnly?: boolean
  /** Performs the move; a `SectionMoveError` is explained instead of thrown. */
  onMove: (to: Place) => void
  /** Called with the readable destination once moved. */
  onMoved: (path: string) => void
}

/** "Move to…": every course and its sections as nested lists; a refused move is explained calmly. */
export function MoveSheet({ open, title, onClose, current, courseOnly = false, onMove, onMoved }: MoveSheetProps) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const roots = useWorkspaceData(['courses', 'sections'], (ws): Node[] => {
    const tree = ws.sections.tree()
    return ws.courses.list().map((c) => ({
      place: { courseId: c.id, sectionId: null },
      label: c.title,
      path: c.title,
      hue: courseHue(c.color, c.id),
      children: sectionNodes(tree, c.id, null, c.title),
    }))
  })
  const shown = courseOnly ? roots.filter((r) => r.place.courseId === current.courseId) : roots

  useEffect(() => {
    if (open) setError(null)
  }, [open])

  const pick = (n: Node) => {
    if (n.place.courseId === current.courseId && n.place.sectionId === current.sectionId) return onClose()
    try {
      onMove(n.place)
    } catch (e) {
      if (!(e instanceof SectionMoveError)) throw e
      setError(
        t(
          e.reason === 'cycle'
            ? 'course.moveCycle'
            : e.reason === 'course'
              ? 'course.moveCourse'
              : 'course.moveMissing',
        ),
      )
      return
    }
    onMoved(n.path)
    onClose()
  }

  const render = (nodes: readonly Node[], label?: string) => (
    <ul className={styles.tree} aria-label={label}>
      {nodes.map((n) => {
        const here = n.place.courseId === current.courseId && n.place.sectionId === current.sectionId
        return (
          <li key={n.place.sectionId ?? n.place.courseId}>
            <button
              type="button"
              className={styles.row}
              aria-current={here ? 'location' : undefined}
              aria-label={here ? t('course.moveHere', { place: n.path }) : n.path}
              onClick={() => pick(n)}
            >
              <span className={styles.icon} aria-hidden="true">
                {n.hue !== undefined ? <CourseDot hue={n.hue} /> : <Folder size={18} strokeWidth={1.75} />}
              </span>
              <span className={styles.label}>{n.label}</span>
            </button>
            {n.children.length > 0 && render(n.children)}
          </li>
        )
      })}
    </ul>
  )

  return (
    <Sheet open={open} title={title} onClose={onClose}>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {render(shown, t('course.movePlaces'))}
    </Sheet>
  )
}
