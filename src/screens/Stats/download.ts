/** Saves a file through a temporary link (works offline, no permissions). */
export function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** A title made safe as a file name; `fallback` when nothing is left. */
export function safeName(title: string, fallback: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, '').trim() || fallback
}
