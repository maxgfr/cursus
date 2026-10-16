import { noteBackup } from '../../../app/lastBackup.ts'
import type { Runtime } from '../../../app/workspaceContext.tsx'
import type { SyncEngineImpl } from '../../../core/sync/engine'
import { download, exportBackup, fileStamp } from '../Sync/registry.ts'
import { saveFile } from './saveFile.ts'

/**
 * Exports the library as one .cursus file: downloaded, or handed to the share sheet (« Save to Files » on iPhone).
 * Null when the share sheet was dismissed; otherwise how many files the library refers to were left out.
 */
export async function saveBackupFile(
  rt: Runtime,
  engine: SyncEngineImpl,
  share: boolean,
): Promise<{ missingFiles: number } | null> {
  const { CURSUS_EXT, CURSUS_MIME } = await import('../../../core/sync/providers/zip')
  const { bytes, missingFiles } = await exportBackup(rt, engine)
  const name = `cursus-${fileStamp(rt.clock.now())}${CURSUS_EXT}`
  if (share) {
    if ((await saveFile(bytes, name, CURSUS_MIME)) === 'cancelled') return null
  } else download(bytes, name, CURSUS_MIME)
  await noteBackup(rt.store, rt.clock.now())
  return { missingFiles }
}
