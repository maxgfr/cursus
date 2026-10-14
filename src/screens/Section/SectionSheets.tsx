import { ArrowDown, ArrowUp, FolderInput, Trash2 } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import type { Id } from '../../core/contracts/workspace'
import type { SectionRecord } from '../../core/model/schema'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import styles from '../Course/Course.module.css'
import { isoDay } from '../Today/exam.ts'

/** Names a new section under the course root or under `parentId`, then opens it. */
export function NewSectionSheet({
  courseId,
  parentId,
  open,
  onClose,
  onCreated,
}: {
  courseId: Id
  parentId: Id | null
  open: boolean
  onClose: () => void
  onCreated: (id: Id) => void
}) {
  const t = useT()
  const ws = useWorkspace()
  const [name, setName] = useState('')
  useEffect(() => {
    if (open) setName('')
  }, [open])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (n === '') return
    const id = ws.sections.create(parentId === null ? { courseId, name: n } : { courseId, parentId, name: n })
    onClose()
    onCreated(id)
  }
  return (
    <Sheet open={open} title={t('course.newSection')} onClose={onClose}>
      <form onSubmit={submit} className={styles.form}>
        <Field
          label={t('course.sectionName')}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          enterKeyHint="done"
          autoComplete="off"
          required
        />
        <Button type="submit" variant="primary" size="large" full disabled={name.trim() === ''}>
          {t('common.save')}
        </Button>
      </form>
    </Sheet>
  )
}

/** Name, exam date, order among its siblings, place and trash of one section. */
export function SectionSettings({
  section,
  siblings,
  open,
  onClose,
  onMove,
  onTrash,
}: {
  section: SectionRecord
  /** Visible siblings in order, the section itself included. */
  siblings: readonly Id[]
  open: boolean
  onClose: () => void
  onMove: () => void
  onTrash: () => void
}) {
  const t = useT()
  const ws = useWorkspace()
  const [name, setName] = useState(section.name)
  const [exam, setExam] = useState(section.examDate ?? '')
  useEffect(() => {
    if (!open) return
    setName(section.name)
    setExam(section.examDate ?? '')
  }, [open, section.name, section.examDate])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (n === '') return
    ws.sections.update(section.id, { name: n, examDate: exam === '' ? undefined : exam })
    onClose()
  }
  const at = siblings.indexOf(section.id)
  const up = () => {
    const before = siblings[at - 1]
    if (before !== undefined) ws.sections.reorder(section.id, before)
  }
  const down = () => {
    if (at < 0 || at >= siblings.length - 1) return
    ws.sections.reorder(section.id, siblings[at + 2] ?? null)
  }

  return (
    <Sheet open={open} title={t('course.sectionSettings')} onClose={onClose}>
      <form onSubmit={submit} className={styles.form}>
        <Field
          label={t('course.sectionName')}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          autoComplete="off"
          required
        />
        <Field
          label={t('course.examDate')}
          hint={t('course.sectionExamHint')}
          type="date"
          min={exam === (section.examDate ?? '') ? undefined : isoDay()}
          value={exam}
          onChange={(e) => setExam(e.currentTarget.value)}
        />
        <Button type="submit" variant="primary" size="large" full disabled={name.trim() === ''}>
          {t('common.save')}
        </Button>
      </form>
      <div className={styles.sheetActions}>
        <Button variant="plain" icon={<ArrowUp size={18} aria-hidden="true" />} onClick={up} disabled={at <= 0}>
          {t('course.moveUp')}
        </Button>
        <Button
          variant="plain"
          icon={<ArrowDown size={18} aria-hidden="true" />}
          onClick={down}
          disabled={at < 0 || at >= siblings.length - 1}
        >
          {t('course.moveDown')}
        </Button>
        <Button variant="plain" icon={<FolderInput size={18} aria-hidden="true" />} onClick={onMove}>
          {t('course.moveTo')}
        </Button>
      </div>
      <div className={styles.danger}>
        <p className={styles.dangerNote}>{t('course.trashSectionNote')}</p>
        <Button variant="danger" full icon={<Trash2 size={18} aria-hidden="true" />} onClick={onTrash}>
          {t('course.trashSection')}
        </Button>
      </div>
    </Sheet>
  )
}
