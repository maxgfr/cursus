import type { RemoteStore } from '../contracts/remote'
import type { ModelWorkspace } from '../model/workspace'
import { exportMarkdown } from './markdown'

export const MIRROR_PREFIX = 'mirror/'

/**
 * Writes the readable export under `mirror/` of a destination. `mirror/` is the only
 * rewritable area: unchanged files are not re-uploaded, stale ones are left for the
 * user (RemoteStore has no delete) and reported.
 */
export async function writeMirror(
  w: ModelWorkspace,
  store: RemoteStore,
): Promise<{ written: number; unchanged: number; stale: string[] }> {
  const files = exportMarkdown(w)
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  let written = 0
  let unchanged = 0
  const existing = new Set<string>()
  for await (const e of store.list(MIRROR_PREFIX)) existing.add(e.key)
  for (const [path, content] of files) {
    const key = MIRROR_PREFIX + path
    if (existing.has(key)) {
      const prev = await store.get({ key })
      if (prev !== null && dec.decode(prev) === content) {
        unchanged++
        continue
      }
    }
    await store.put(key, enc.encode(content))
    written++
  }
  const stale = [...existing].filter((k) => !files.has(k.slice(MIRROR_PREFIX.length))).sort()
  return { written, unchanged, stale }
}
