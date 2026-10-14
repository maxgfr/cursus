import type { IdbStore } from '../../core/storage/idbStore.ts'

/** The fields a card draft edits before Save. */
export interface CardFields {
  kind: 'basic' | 'cloze'
  front: string
  back: string
}

/** Route id of a card not created yet: `new.<courseId>`. It is created only on Save. */
const NEW = 'new.'
export const newCardId = (courseId: string): string => NEW + courseId
export const newCardCourse = (id: string): string | null => (id.startsWith(NEW) ? id.slice(NEW.length) : null)

/** Device-only key of a card's unsaved draft (never in the workspace doc). */
export const draftKey = (id: string): string => `draft:card:${id}`

export const sameFields = (a: CardFields, b: CardFields): boolean =>
  a.kind === b.kind && a.front === b.front && a.back === b.back

export const EMPTY: CardFields = { kind: 'basic', front: '', back: '' }

function isFields(v: unknown): v is CardFields {
  return (
    typeof v === 'object' &&
    v !== null &&
    'kind' in v &&
    (v.kind === 'basic' || v.kind === 'cloze') &&
    'front' in v &&
    typeof v.front === 'string' &&
    'back' in v &&
    typeof v.back === 'string'
  )
}

/** A kept draft and the card values it was seeded from (its base, for a three-way Save). */
export interface KeptDraft {
  fields: CardFields
  /** Null for a draft kept before bases were stored: the caller takes the saved card. */
  base: CardFields | null
}

export async function readDraft(store: IdbStore, id: string): Promise<KeptDraft | null> {
  const v = await store.read(['kv'], (tx) => tx.get<unknown>('kv', draftKey(id)))
  if (typeof v === 'object' && v !== null && 'fields' in v && isFields(v.fields))
    return { fields: v.fields, base: 'base' in v && isFields(v.base) ? v.base : null }
  return isFields(v) ? { fields: v, base: null } : null
}

/** Keeps the draft and its base while the draft differs from the base; drops it once they match. */
export async function keepDraft(store: IdbStore, id: string, draft: CardFields, base: CardFields): Promise<void> {
  await store.commit(
    sameFields(draft, base)
      ? [{ delete: 'kv', key: draftKey(id) }]
      : [{ put: 'kv', key: draftKey(id), value: { fields: draft, base } }],
  )
}

export const dropDraft = (store: IdbStore, id: string): Promise<void> =>
  store.commit([{ delete: 'kv', key: draftKey(id) }])
