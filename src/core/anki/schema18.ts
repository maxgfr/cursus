import type { Database } from 'sql.js'
import { notetypeKind } from './mediaProto'
import { type AnkiCollection, type AnkiNotetype, readCommon, rows } from './schema11'

/** Schema 18 (`collection.anki21b`): separate `notetypes`/`fields`/`decks` tables, deck paths use `\x1f`. */
export function readSchema18(db: Database): AnkiCollection {
  const notetypes = new Map<number, AnkiNotetype>()
  for (const r of rows(db, 'select id, name, config from notetypes')) {
    const config = r[2] instanceof Uint8Array ? r[2] : new Uint8Array()
    notetypes.set(Number(r[0]), { name: String(r[1]), kind: notetypeKind(config), fields: [] })
  }
  const fields = rows(db, 'select ntid, ord, name from fields').sort((a, b) => Number(a[1]) - Number(b[1]))
  for (const r of fields) notetypes.get(Number(r[0]))?.fields.push(String(r[2]))
  const decks = new Map<number, string[]>()
  for (const r of rows(db, 'select id, name from decks')) decks.set(Number(r[0]), String(r[1]).split('\x1f'))
  return { notetypes, decks, ...readCommon(db) }
}
