import { Camera, ClipboardPaste, FileText, PenLine, Presentation } from 'lucide-react'
import { Link } from 'wouter'
import { useT } from '../../i18n/react.tsx'
import { buttonClass } from '../../ui/components/Button.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import styles from './Course.module.css'

export interface AddSheetProps {
  open: boolean
  onClose: () => void
  onNote: () => void
  onPdf: () => void
  onPhoto: () => void
  onPaste: () => void
  /** Slides or a structured document, imported on its own screen. */
  deckHref: string
}

/** Every way to add a source to this place; each choice closes the sheet. */
export function AddSheet({ open, onClose, onNote, onPdf, onPhoto, onPaste, deckHref }: AddSheetProps) {
  const t = useT()
  const pick = (action: () => void) => () => {
    onClose()
    action()
  }
  return (
    <Sheet open={open} title={t('course.addTitle')} onClose={onClose}>
      <ListGroup title={t('course.addTitle')} hideTitle>
        <ListRow leading={<PenLine size={20} />} title={t('course.writeNote')} onClick={pick(onNote)} />
        <ListRow leading={<FileText size={20} />} title={t('course.importPdf')} onClick={pick(onPdf)} />
        <ListRow leading={<Camera size={20} />} title={t('course.takePhoto')} onClick={pick(onPhoto)} />
        <ListRow leading={<ClipboardPaste size={20} />} title={t('course.pasteText')} onClick={pick(onPaste)} />
      </ListGroup>
      <div className={styles.actions}>
        {/* Slides or a structured document (.pptx, .docx, .pdf), read slide by slide or section by section. */}
        <Link href={deckHref} className={buttonClass({})} onClick={onClose}>
          <Presentation size={18} aria-hidden="true" />
          {t('ai.deckImportAction')}
        </Link>
      </div>
    </Sheet>
  )
}
