import type { EngineStatus } from '../core/sync/status'
import type { SyncSummary } from '../ui/components/Badges.tsx'
import type { SaveState } from './workspaceContext.tsx'

const ATTENTION = new Set(['needs-auth', 'needs-passphrase', 'needs-permission', 'error'])

/**
 * The chip's words, derived from verified state only. `stale` is true while a local change
 * (captured, appended or sealed) is newer than `status`: until a refresh counts it, it is not protected.
 */
export function summarize(
  status: EngineStatus | null,
  save: SaveState,
  online: boolean,
  error: unknown,
  stale: boolean,
): SyncSummary {
  if (save.blocked || save.versionChanged) return { kind: 'unsaved' }
  if (error !== null) return { kind: 'attention' }
  if (status === null || status.dests.length === 0) return { kind: 'local' }
  if (status.alarm || status.needsUpgrade > 0 || status.dests.some((d) => ATTENTION.has(d.state)))
    return { kind: 'attention' }
  if (!online) return { kind: 'offline' }
  if (status.safe && !stale && save.unsaved === 0) return { kind: 'protected', count: status.protectedOn }
  return { kind: 'syncing' }
}
