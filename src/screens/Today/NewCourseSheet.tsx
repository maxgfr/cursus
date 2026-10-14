import { type FormEvent, useState } from 'react'
import { useLocation } from 'wouter'
import { to } from '../../app/routes.ts'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import styles from './Today.module.css'

/** Creates a course on an explicit action only (nothing is ever seeded). */
export function NewCourseSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const ws = useWorkspace()
  const [, navigate] = useLocation()
  const [title, setTitle] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const name = title.trim()
    if (name === '') return
    const id = ws.courses.create({ title: name })
    onClose()
    setTitle('')
    navigate(to.course(id))
  }
  return (
    <Sheet open={open} title={t('today.addCourse')} onClose={onClose}>
      <form onSubmit={submit} className={styles.form}>
        <Field
          label={t('course.name')}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          enterKeyHint="done"
          autoComplete="off"
          required
        />
        <Button type="submit" variant="primary" size="large" full disabled={title.trim() === ''}>
          {t('common.save')}
        </Button>
      </form>
    </Sheet>
  )
}
