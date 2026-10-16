import { useCallback } from 'react'
import { useSync } from '../../../app/syncContext.tsx'
import { useRuntime } from '../../../app/workspaceContext.tsx'
import { liveQueue } from '../../../ui/data/autoQuestions.ts'

/** How long erasing waits for a sync in flight to end before going on without it. */
const SYNC_WAIT_MS = 5_000

/**
 * What « Erase everything » runs first (`EraseHooks.stop`): the sync stops (one in flight ends first, for a while),
 * then the AI queue, then the library's own writes, for good.
 */
export function useStopWriting(): () => Promise<void> {
  const rt = useRuntime()
  const { scheduler } = useSync()
  return useCallback(async () => {
    if (scheduler) {
      scheduler.stop()
      await Promise.race([scheduler.whenIdle(), new Promise((r) => setTimeout(r, SYNC_WAIT_MS))])
    }
    liveQueue()?.stop()
    rt.shutdown()
  }, [rt, scheduler])
}
