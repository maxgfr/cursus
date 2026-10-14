import type { Database, SqlJsStatic, SqlValue } from 'sql.js'

/** Engine-neutral view of an Anki collection, shared by the schema 11 and 18 readers. */
export interface AnkiNotetype {
  name: string
  kind: 'normal' | 'cloze'
  fields: string[]
}
export interface AnkiNote {
  id: number
  guid: string
  mid: number
  fields: string[]
  tags: string[]
}
export interface AnkiCard {
  id: number
  nid: number
  did: number
  ord: number
  queue: number
}
export interface AnkiRevlog {
  id: number
  cid: number
  ease: number
  time: number
  type: number
}
export interface AnkiCollection {
  notetypes: Map<number, AnkiNotetype>
  /** Deck id -> path segments. */
  decks: Map<number, string[]>
  notes: Map<number, AnkiNote>
  cards: AnkiCard[]
  revlog: AnkiRevlog[]
}

let sqlPromise: Promise<SqlJsStatic> | null = null

/** Loads sql.js lazily; the wasm path is a static relative URL so both Bun and Vite resolve it. */
export function loadSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const [{ default: initSqlJs }, res] = await Promise.all([
        import('sql.js'),
        fetch(new URL('../../../node_modules/sql.js/dist/sql-wasm.wasm', import.meta.url)),
      ])
      if (!res.ok) throw new Error(`sql.js wasm: HTTP ${res.status}`)
      return initSqlJs({ wasmBinary: await res.arrayBuffer() })
    })()
    sqlPromise.catch(() => {
      sqlPromise = null
    })
  }
  return sqlPromise
}

export function rows(db: Database, sql: string): SqlValue[][] {
  return db.exec(sql)[0]?.values ?? []
}

const num = (v: SqlValue | undefined): number => Number(v ?? 0)
const str = (v: SqlValue | undefined): string => (v === null || v === undefined ? '' : String(v))

/** Notes, cards and revlog share their columns across schemas 11 and 18. */
export function readCommon(db: Database): Pick<AnkiCollection, 'notes' | 'cards' | 'revlog'> {
  const notes = new Map<number, AnkiNote>()
  for (const r of rows(db, 'select id, guid, mid, flds, tags from notes order by id')) {
    notes.set(num(r[0]), {
      id: num(r[0]),
      guid: str(r[1]),
      mid: num(r[2]),
      fields: str(r[3]).split('\x1f'),
      tags: str(r[4]).split(' ').filter(Boolean),
    })
  }
  const cards = rows(db, 'select id, nid, did, ord, queue from cards order by nid, ord').map((r) => ({
    id: num(r[0]),
    nid: num(r[1]),
    did: num(r[2]),
    ord: num(r[3]),
    queue: num(r[4]),
  }))
  const revlog = rows(db, 'select id, cid, ease, time, type from revlog order by id').map((r) => ({
    id: num(r[0]),
    cid: num(r[1]),
    ease: num(r[2]),
    time: num(r[3]),
    type: num(r[4]),
  }))
  return { notes, cards, revlog }
}

interface LegacyModel {
  name?: string
  type?: number
  flds?: { name?: string; ord?: number }[]
}

/** Schema 11: notetypes and decks are JSON blobs in `col`, deck paths use `::`. */
export function readSchema11(db: Database): AnkiCollection {
  const col = rows(db, 'select models, decks from col')[0]
  if (!col) throw new Error('Anki collection has no col row')
  const models = JSON.parse(str(col[0])) as Record<string, LegacyModel>
  const decksJson = JSON.parse(str(col[1])) as Record<string, { name?: string }>
  const notetypes = new Map<number, AnkiNotetype>()
  for (const [id, m] of Object.entries(models)) {
    const flds = [...(m.flds ?? [])].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))
    notetypes.set(Number(id), {
      name: m.name ?? '',
      kind: m.type === 1 ? 'cloze' : 'normal',
      fields: flds.map((f) => f.name ?? ''),
    })
  }
  const decks = new Map<number, string[]>()
  for (const [id, d] of Object.entries(decksJson)) decks.set(Number(id), (d.name ?? '').split('::'))
  return { notetypes, decks, ...readCommon(db) }
}

/** Schema 11 DDL, as written by Anki 2.1 legacy exports. */
export const SCHEMA11_DDL = `
create table col (id integer primary key, crt integer not null, mod integer not null, scm integer not null,
  ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null, tags text not null);
create table notes (id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null,
  flags integer not null, data text not null);
create table cards (id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null,
  ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null,
  odue integer not null, odid integer not null, flags integer not null, data text not null);
create table revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
create table graves (usn integer not null, oid integer not null, type integer not null);
create index ix_notes_usn on notes (usn);
create index ix_cards_usn on cards (usn);
create index ix_revlog_usn on revlog (usn);
create index ix_cards_nid on cards (nid);
create index ix_cards_sched on cards (did, queue, due);
create index ix_revlog_cid on revlog (cid);
create index ix_notes_csum on notes (csum);
`
