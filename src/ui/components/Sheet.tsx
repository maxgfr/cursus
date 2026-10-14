import { X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef } from 'react'
import { useT } from '../../i18n/react.tsx'
import { IconButton } from './IconButton.tsx'
import styles from './Sheet.module.css'

export interface SheetProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}

/** Native modal <dialog>: bottom sheet on phones, centred panel elsewhere. Escape closes it. */
export function Sheet({ open, title, onClose, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  const t = useT()

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog ref={ref} className={styles.sheet} aria-labelledby={id} onClose={onClose}>
      <div className={styles.header}>
        <h2 id={id} className={styles.title}>
          {title}
        </h2>
        <IconButton icon={X} label={t('common.close')} onClick={onClose} />
      </div>
      <div className={styles.body}>{children}</div>
    </dialog>
  )
}
