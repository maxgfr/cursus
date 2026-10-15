import { Camera, ClipboardPaste, FileUp, PenLine } from 'lucide-react'
import { useT } from '../../i18n/react.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'

export interface AddSheetProps {
  open: boolean
  onClose: () => void
  /** One or more files: PDF, PowerPoint, Word, photos, text; each is read by what it is. */
  onFiles: () => void
  onNote: () => void
  onPhoto: () => void
  onPaste: () => void
}

/** Every way to add a source to this place; each choice closes the sheet. */
export function AddSheet({ open, onClose, onFiles, onNote, onPhoto, onPaste }: AddSheetProps) {
  const t = useT()
  const pick = (action: () => void) => () => {
    onClose()
    action()
  }
  return (
    <Sheet open={open} title={t('course.addTitle')} onClose={onClose}>
      <ListGroup title={t('course.addTitle')} hideTitle footer={t('course.addFilesHint')}>
        <ListRow leading={<FileUp size={20} />} title={t('course.addFiles')} onClick={pick(onFiles)} />
        <ListRow leading={<PenLine size={20} />} title={t('course.writeNote')} onClick={pick(onNote)} />
        <ListRow leading={<Camera size={20} />} title={t('course.takePhoto')} onClick={pick(onPhoto)} />
        <ListRow leading={<ClipboardPaste size={20} />} title={t('course.pasteText')} onClick={pick(onPaste)} />
      </ListGroup>
    </Sheet>
  )
}
