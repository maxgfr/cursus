import * as Y from 'yjs'
import type { SegmentRec } from '../../core/contracts/log'
import { REPLAY } from '../../core/log/origins'
import { ROOT, type TextField, textKey } from '../../core/model/schema'

export interface Version {
  /** When the segment that produced this state was sealed. */
  at: number
  text: string
}

/**
 * Replays the persisted segments, oldest first, into a scratch doc (never the workspace's) and keeps
 * every distinct state of one text. A version is the text as it stood once a segment was applied.
 */
export function textVersions(
  segments: readonly { rec: SegmentRec; update: Uint8Array }[],
  id: string,
  field: TextField,
): Version[] {
  const ordered = [...segments].sort(
    (a, b) => a.rec.header.createdAt - b.rec.header.createdAt || a.rec.arrival - b.rec.arrival,
  )
  const doc = new Y.Doc()
  const key = textKey(id, field)
  const versions: Version[] = []
  let last: string | null = null
  try {
    for (const { rec, update } of ordered) {
      Y.applyUpdateV2(doc, update, REPLAY)
      const t = doc.getMap<Y.Text>(ROOT.texts).get(key)
      if (t === undefined) continue
      const text = t.toString()
      if (text === last) continue
      last = text
      // Segments sealed in the same millisecond collapse into one version.
      const prev = versions.at(-1)
      if (prev?.at === rec.header.createdAt) prev.text = text
      else versions.push({ at: rec.header.createdAt, text })
    }
  } finally {
    doc.destroy()
  }
  return versions
}

/** The text as of `at`: the latest version sealed at or before it ("" before the first). */
export function textAt(versions: readonly Version[], at: number): string {
  let out = ''
  for (const v of versions) {
    if (v.at > at) break
    out = v.text
  }
  return out
}

export { applyForward } from '../../core/model/textForward'
