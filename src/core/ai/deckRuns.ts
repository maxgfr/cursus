/**
 * Runs of the former « Create cards » screen, kept on this device under `deck:questions:<source>` (never synced):
 * their questions not saved yet become proposed drafts of their source, so they wait in « Suggested cards » with the
 * others; the questions rejected there become rejected drafts, so they never come back. Then the key goes.
 *
 * Safe to run again (a run cut half-way, two tabs): a question its source already has a draft for is not written
 * twice. A run whose source is gone is dropped with it.
 */
import type { LocalStore } from '../contracts/ports'
import type { Id } from '../contracts/workspace'
import { type NewDraft, questionKey } from '../model/drafts'
import type { ModelWorkspace } from '../model/workspace'

export const DECK_RUN_PREFIX = 'deck:questions:'

interface StoredDraft {
  unit: number
  kind: 'basic' | 'cloze'
  type: 'qa' | 'cloze' | 'explain'
  difficulty?: 'easy' | 'medium' | 'hard'
  front: string
  back: string
  quote?: string
  status: 'pending' | 'accepted' | 'rejected'
}

const TYPES = new Set(['qa', 'cloze', 'explain'])
const DIFFICULTIES = new Set(['easy', 'medium', 'hard'])
const STATUSES = new Set(['pending', 'accepted', 'rejected'])

function storedDraft(v: unknown): v is StoredDraft {
  if (typeof v !== 'object' || v === null) return false
  const d = v as Record<string, unknown>
  return (
    Number.isInteger(d.unit) &&
    (d.unit as number) >= 0 &&
    (d.kind === 'basic' || d.kind === 'cloze') &&
    TYPES.has(d.type as string) &&
    typeof d.front === 'string' &&
    typeof d.back === 'string' &&
    STATUSES.has(d.status as string)
  )
}

/** Moves every stored run into drafts; returns how many drafts were written. */
export async function migrateDeckRuns(ws: ModelWorkspace, store: LocalStore): Promise<number> {
  const keys = await store.read(['kv'], (tx) =>
    tx.getAllKeys('kv', { lower: DECK_RUN_PREFIX, upper: `${DECK_RUN_PREFIX}￿` }),
  )
  let written = 0
  for (const key of keys) {
    if (typeof key !== 'string' || !key.startsWith(DECK_RUN_PREFIX)) continue
    const raw = await store.read(['kv'], (tx) => tx.get<unknown>('kv', key))
    written += moveRun(ws, key.slice(DECK_RUN_PREFIX.length), raw)
    await store.commit([{ delete: 'kv', key }])
  }
  return written
}

function moveRun(ws: ModelWorkspace, sourceId: Id, raw: unknown): number {
  const source = ws.sources.get(sourceId)
  if (!source || source.deletedAt !== undefined || typeof raw !== 'object' || raw === null) return 0
  const run = raw as { drafts?: unknown; rejected?: unknown; settings?: { sectionId?: unknown } }
  const drafts = Array.isArray(run.drafts) ? run.drafts.filter(storedDraft) : []
  const rejected = [
    ...(Array.isArray(run.rejected) ? run.rejected.filter((f): f is string => typeof f === 'string') : []),
    ...drafts.filter((d) => d.status === 'rejected').map((d) => d.front),
  ]
  const sectionId = typeof run.settings?.sectionId === 'string' ? run.settings.sectionId : ''
  // What the source already has, whatever became of it: never written twice.
  const known = new Set<string>()
  for (const d of ws.drafts.all()) {
    if (d.sourceId !== sourceId) continue
    known.add(questionKey(d.proposed))
    known.add(questionKey(d.front))
  }
  const fresh = (front: string): boolean => {
    const k = questionKey(front)
    if (k === '' || known.has(k)) return false
    known.add(k)
    return true
  }
  const base = { sourceId, courseId: source.courseId, ...(sectionId === '' ? {} : { sectionId }) }
  let written = 0
  const propose = (d: NewDraft): Id | null => {
    try {
      const [id] = ws.drafts.propose([d])
      written++
      return id ?? null
    } catch {
      // A question this version cannot keep (a cloze without its blank): left out.
      return null
    }
  }
  ws.atomic(() => {
    for (const d of drafts) {
      if (d.status === 'rejected' || !fresh(d.front)) continue
      const draft: NewDraft = { ...base, unit: d.unit, kind: d.kind, type: d.type, front: d.front, back: d.back }
      if (d.difficulty !== undefined && DIFFICULTIES.has(d.difficulty)) draft.difficulty = d.difficulty
      if (d.quote !== undefined) draft.quote = d.quote
      propose(draft)
    }
    for (const front of rejected) {
      if (!fresh(front) || ws.drafts.isRejected(front)) continue
      const id = propose({ ...base, unit: 0, kind: 'basic', type: 'qa', front, back: '' })
      if (id !== null) ws.drafts.reject(id)
    }
  })
  return written
}
