import type {
  DeckQuestion,
  DeckQuestionsProgress,
  DifficultyMix,
  QuestionDifficulty,
  QuestionType,
} from '../../core/ai/features/deckQuestions'
import type { IdbStore } from '../../core/storage/idbStore'

/** What the student chose before running. */
export interface DeckSettings {
  /** First and last unit of the range (unit numbers). */
  from: number
  to: number
  perUnit: number
  types: QuestionType[]
  difficulty: DifficultyMix
  /** '' for the course's language, else a language code. */
  language: string
  /** Where the cards are saved: '' for the course root, else a subset of the course. */
  sectionId: string
  /** Slides hidden in the presentation are left out unless asked for. */
  hidden: boolean
}

export type DraftStatus = 'pending' | 'accepted' | 'rejected'

/** A question waiting for review: nothing becomes a card before an explicit Save. */
export interface StoredDraft {
  id: string
  unit: number
  kind: 'basic' | 'cloze'
  type: QuestionType
  difficulty: QuestionDifficulty
  front: string
  back: string
  quote?: string
  status: DraftStatus
}

/**
 * A run kept on this device (IndexedDB `kv`, never the synced doc): the settings, the units still to do, the
 * finished units' progress (to resume after a cut or a cancel) and the drafts under review.
 */
export interface DeckRun {
  v: 1
  settings: DeckSettings
  /** The units this run covers, in order. */
  units: number[]
  progress: DeckQuestionsProgress
  textOnly: boolean
  drafts: StoredDraft[]
  /** Fronts the student rejected: a resumed or new run does not propose them again. */
  rejected: string[]
  /** Duplicates dropped so far. */
  duplicates: number
}

export const runKey = (sourceId: string): string => `deck:questions:${sourceId}`

function isRun(v: unknown): v is DeckRun {
  return (
    typeof v === 'object' &&
    v !== null &&
    'v' in v &&
    v.v === 1 &&
    'units' in v &&
    Array.isArray(v.units) &&
    'drafts' in v &&
    Array.isArray(v.drafts) &&
    'progress' in v &&
    typeof v.progress === 'object'
  )
}

export async function readRun(store: IdbStore, sourceId: string): Promise<DeckRun | null> {
  const v = await store.read(['kv'], (tx) => tx.get<unknown>('kv', runKey(sourceId)))
  return isRun(v) ? v : null
}

export function keepRun(store: IdbStore, sourceId: string, run: DeckRun | null): Promise<void> {
  return store.commit(
    run === null ? [{ delete: 'kv', key: runKey(sourceId) }] : [{ put: 'kv', key: runKey(sourceId), value: run }],
  )
}

/** Units of the run not finished yet. */
export function remainingUnits(run: Pick<DeckRun, 'units' | 'progress'>): number[] {
  return run.units.filter((u) => run.progress.done[u] === undefined)
}

/** New drafts for the units that just finished (ids stable: unit and position). */
export function draftsFor(units: readonly number[], done: Readonly<Record<number, DeckQuestion[]>>): StoredDraft[] {
  const out: StoredDraft[] = []
  for (const unit of units) {
    for (const [k, q] of (done[unit] ?? []).entries()) {
      const d: StoredDraft = {
        id: `${unit}-${k}`,
        unit,
        kind: q.kind,
        type: q.type,
        difficulty: q.difficulty,
        front: q.front,
        back: q.back,
        status: 'pending',
      }
      if (q.quote) d.quote = q.quote
      out.push(d)
    }
  }
  return out
}
