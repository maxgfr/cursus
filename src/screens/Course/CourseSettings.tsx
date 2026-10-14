import { type FormEvent, useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import type { CourseRecord } from '../../core/model/schema'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { isoDay } from '../Today/exam.ts'
import styles from './Course.module.css'

/** Name, exam date and deletion (to the trash) of one course. */
export function CourseSettings({
  course,
  open,
  onClose,
}: {
  course: CourseRecord
  open: boolean
  onClose: () => void
}) {
  const t = useT()
  const ws = useWorkspace()
  const [, navigate] = useLocation()
  const [title, setTitle] = useState(course.title)
  const [exam, setExam] = useState(course.examDate ?? '')
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle(course.title)
    setExam(course.examDate ?? '')
    setConfirming(false)
  }, [open, course.title, course.examDate])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const name = title.trim()
    if (name === '') return
    ws.courses.update(course.id, { title: name, examDate: exam === '' ? undefined : exam })
    onClose()
  }
  const remove = () => {
    ws.courses.trash(course.id)
    onClose()
    navigate(paths.courses)
  }

  return (
    <Sheet open={open} title={t('course.settings')} onClose={onClose}>
      <form onSubmit={submit} className={styles.form}>
        <Field
          label={t('course.name')}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          autoComplete="off"
          required
        />
        <Field
          label={t('course.examDate')}
          hint={t('course.examHint')}
          type="date"
          // Only a newly picked date must lie ahead: a past exam date stays as it is, so the
          // course can still be renamed after the exam.
          min={exam === (course.examDate ?? '') ? undefined : isoDay()}
          value={exam}
          onChange={(e) => setExam(e.currentTarget.value)}
        />
        <Button type="submit" variant="primary" size="large" full disabled={title.trim() === ''}>
          {t('common.save')}
        </Button>
      </form>
      <div className={styles.danger}>
        {confirming ? (
          <>
            <p>{t('course.deleteConfirm', { name: course.title })}</p>
            <p className={styles.dangerNote}>{t('course.deleteNote')}</p>
            <Button variant="danger" full onClick={remove}>
              {t('course.deleteCourse')}
            </Button>
            <Button variant="plain" full onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button variant="danger" full onClick={() => setConfirming(true)}>
            {t('course.deleteCourse')}
          </Button>
        )}
      </div>
    </Sheet>
  )
}
