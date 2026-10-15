import { useEffect, useRef } from 'react'

export type Captured = { kind: 'image'; blob: Blob; name?: string } | { kind: 'text'; text: string }

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function imagesFrom(data: DataTransfer): Captured[] {
  const out: Captured[] = []
  for (const file of Array.from(data.files)) {
    if (file.type.startsWith('image/')) out.push({ kind: 'image', blob: file, name: file.name || undefined })
  }
  return out
}

/**
 * Captures ⌘V / Ctrl+V pastes and drag-and-drop anywhere on the page.
 * Pastes into editable fields are left alone unless they carry images.
 */
export function usePasteCapture(
  onCapture: (c: Captured) => void,
  opts?: { enabled?: boolean; onFiles?: (files: File[]) => void },
): void {
  const enabled = opts?.enabled ?? true
  const handler = useRef(onCapture)
  handler.current = onCapture
  const filesHandler = useRef(opts?.onFiles)
  filesHandler.current = opts?.onFiles

  useEffect(() => {
    if (!enabled) return
    /** Files other than photos (a PDF, a slide deck…) go whole to `onFiles` when the screen takes them. */
    const takeFiles = (data: DataTransfer): boolean => {
      const onFiles = filesHandler.current
      const files = Array.from(data.files)
      if (onFiles === undefined || !files.some((f) => !f.type.startsWith('image/'))) return false
      onFiles(files)
      return true
    }
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData
      if (data === null) return
      if (takeFiles(data)) {
        event.preventDefault()
        return
      }
      const images = imagesFrom(data)
      if (images.length > 0) {
        event.preventDefault()
        for (const c of images) handler.current(c)
        return
      }
      if (isEditable(event.target)) return
      const text = data.getData('text/plain')
      if (text.trim() === '') return
      event.preventDefault()
      handler.current({ kind: 'text', text })
    }
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files') || event.dataTransfer?.types.includes('text/plain')) {
        event.preventDefault()
      }
    }
    const onDrop = (event: DragEvent) => {
      const data = event.dataTransfer
      if (data === null) return
      if (takeFiles(data)) {
        event.preventDefault()
        return
      }
      const images = imagesFrom(data)
      if (images.length > 0) {
        event.preventDefault()
        for (const c of images) handler.current(c)
        return
      }
      if (isEditable(event.target)) return
      const text = data.getData('text/plain')
      if (text.trim() === '') return
      event.preventDefault()
      handler.current({ kind: 'text', text })
    }
    document.addEventListener('paste', onPaste)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [enabled])
}
