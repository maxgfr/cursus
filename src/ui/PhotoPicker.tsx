import { Camera, ImagePlus } from 'lucide-react'
import { type ChangeEvent, useRef } from 'react'
import { useT } from '../i18n/react.tsx'
import { Button, type ButtonVariant } from './components/Button.tsx'
import styles from './PhotoPicker.module.css'

export interface PhotoPickerProps {
  onFiles: (files: File[]) => void
  busy?: boolean
  /** Several photos at once from the library (the camera always takes one). */
  multiple?: boolean
  /** The emphasis of "Add photos" (the camera button follows it on touch screens). */
  variant?: ButtonVariant
  /** Overrides "Add photos" (e.g. "Add photo" on a card). */
  addLabel?: string
}

/**
 * Two ways in: the camera (`capture`) on iPhone and iPad, and the photo library or files everywhere (several at
 * once). Paste and drag-and-drop are the screen's job (see `usePasteCapture`).
 */
export function PhotoPicker({ onFiles, busy = false, multiple = true, variant, addLabel }: PhotoPickerProps) {
  const t = useT()
  const camera = useRef<HTMLInputElement>(null)
  const library = useRef<HTMLInputElement>(null)
  const take = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.currentTarget.files ?? [])]
    e.currentTarget.value = ''
    if (files.length > 0) onFiles(files)
  }
  return (
    <div className={styles.picker}>
      <Button
        className={styles.camera}
        variant={variant}
        icon={<Camera size={18} aria-hidden="true" />}
        onClick={() => camera.current?.click()}
        disabled={busy}
      >
        {t('photos.takePhoto')}
      </Button>
      <Button
        variant={variant}
        icon={<ImagePlus size={18} aria-hidden="true" />}
        onClick={() => library.current?.click()}
        loading={busy}
      >
        {addLabel ?? t('photos.addPhotos')}
      </Button>
      <input
        ref={camera}
        className="sr-only"
        type="file"
        accept="image/*"
        capture="environment"
        // Reached through its visible button only.
        aria-hidden="true"
        tabIndex={-1}
        onChange={take}
      />
      <input
        ref={library}
        className="sr-only"
        type="file"
        accept="image/*,.heic,.heif"
        multiple={multiple}
        aria-hidden="true"
        tabIndex={-1}
        onChange={take}
      />
    </div>
  )
}
