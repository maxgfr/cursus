/**
 * Files the OS opened with the installed app (manifest `file_handlers`: `.cursus`). Chromium hands them
 * over through `window.launchQueue`; launches made before a consumer is set wait in the queue.
 */
interface LaunchParams {
  readonly files: readonly { getFile(): Promise<File> }[]
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void
}

/** Calls `onFiles` with the files of every launch (now and later). A no-op where unsupported. */
export function consumeLaunchedFiles(onFiles: (files: File[]) => void, onError: (e: unknown) => void): void {
  const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue
  if (!queue) return
  queue.setConsumer((params) => {
    if (params.files.length === 0) return
    Promise.all(params.files.map((h) => h.getFile())).then(onFiles, onError)
  })
}
