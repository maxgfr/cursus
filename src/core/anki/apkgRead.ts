import { unzipSync } from 'fflate'
import { decompress } from 'fzstd'
import type { BlobStore } from '../contracts/log'
import type { Id, Rating } from '../contracts/workspace'
import type { ModelWorkspace } from '../model/workspace'
import { ankiToMarkdown, type HtmlConverter, mediaRefs, turndownConverter } from './htmlToMd'
import { decodeMediaEntries } from './mediaProto'
import { type AnkiCard, type AnkiCollection, type AnkiNote, type AnkiNotetype, loadSql, readSchema11 } from './schema11'
import { readSchema18 } from './schema18'

export class ApkgError extends Error {
  constructor(m: string) {
    super(m)
    this.name = 'ApkgError'
  }
}

export interface ApkgContents {
  format: 'anki21b' | 'anki21' | 'anki2'
  collection: AnkiCollection
  media: Map<string, Uint8Array>
}

const isZstd = (b: Uint8Array): boolean => b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd

/** Unpacks an `.apkg`/`.colpkg`: `collection.anki21b` first (the `collection.anki2` beside it is a dummy), then `anki21`, then `anki2`. */
export async function readApkg(bytes: Uint8Array): Promise<ApkgContents> {
  let zip: Record<string, Uint8Array>
  try {
    zip = unzipSync(bytes)
  } catch (e) {
    throw new ApkgError(`Not a zip archive: ${String(e)}`)
  }
  const SQL = await loadSql()
  let format: ApkgContents['format']
  let collection: AnkiCollection
  const modern = zip['collection.anki21b']
  const legacy = zip['collection.anki21'] ?? zip['collection.anki2']
  if (modern) {
    format = 'anki21b'
    const db = new SQL.Database(decompress(modern))
    try {
      collection = readSchema18(db)
    } finally {
      db.close()
    }
  } else if (legacy) {
    format = zip['collection.anki21'] ? 'anki21' : 'anki2'
    const db = new SQL.Database(legacy)
    try {
      collection = readSchema11(db)
    } finally {
      db.close()
    }
  } else {
    throw new ApkgError('No Anki collection in package')
  }
  return { format, collection, media: readMedia(zip) }
}

function readMedia(zip: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const raw = zip.media
  if (!raw || raw.length === 0) return out
  let names: [string, string][]
  if (isZstd(raw)) {
    names = decodeMediaEntries(decompress(raw)).map((e, i) => [String(i), e.name])
  } else {
    const text = new TextDecoder().decode(raw)
    names = Object.entries(JSON.parse(text === '' ? '{}' : text) as Record<string, string>)
  }
  for (const [member, name] of names) {
    const data = zip[member]
    if (data) out.set(name, isZstd(data) ? decompress(data) : data)
  }
  return out
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  flac: 'audio/flac',
}

export function mimeOf(name: string): string {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g

/** The cursus front/back of one Anki card (still HTML). */
export function cardSides(note: AnkiNote, type: AnkiNotetype, ord: number): { front: string; back: string } {
  const f = note.fields
  const label = (skip: Set<number>): string[] =>
    f.flatMap((v, i) =>
      skip.has(i) || v.trim() === '' ? [] : [`<p><b>${type.fields[i] ?? `Field ${i + 1}`}:</b> ${v}</p>`],
    )
  if (type.kind === 'cloze') {
    const index = ord + 1
    const front = (f[0] ?? '').replace(CLOZE, (m, n: string, answer: string) => (Number(n) === index ? m : answer))
    return { front, back: label(new Set([0])).join('') }
  }
  const frontIdx = ord < f.length ? ord : 0
  const backIdx = frontIdx === 0 ? 1 : 0
  const extras = label(new Set([frontIdx, backIdx]))
  return { front: f[frontIdx] ?? '', back: [f[backIdx] ?? '', ...extras].filter(Boolean).join('') }
}

export function courseTitle(path: readonly string[]): string {
  const p = path.length > 1 && path[0] === 'Cursus' ? path.slice(1) : path
  return p.join('::') || 'Anki'
}

export interface ImportOptions {
  /** Import the revlog as reviews (default true). */
  keepHistory?: boolean
  htmlToMarkdown?: HtmlConverter
}

export interface ImportResult {
  format: ApkgContents['format']
  imported: number
  skipped: number
  reviews: number
  media: number
  courseIds: Id[]
}

/** Imports a package: deck => course, card => card, revlog => reviews. Cards already imported (same `ankiGuid`) are skipped. */
export async function importApkg(
  bytes: Uint8Array,
  ws: ModelWorkspace,
  blobs: BlobStore,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const { format, collection, media } = await readApkg(bytes)
  const convert = opts.htmlToMarkdown ?? turndownConverter
  const known = new Set<string>()
  for (const trashed of [false, true]) {
    for (const c of ws.cards.list({ trashed })) {
      known.add(c.id)
      if (c.ankiGuid) known.add(c.ankiGuid)
    }
  }

  const todo: { card: AnkiCard; note: AnkiNote; type: AnkiNotetype; guid: string }[] = []
  let skipped = 0
  for (const card of collection.cards) {
    const note = collection.notes.get(card.nid)
    const type = note && collection.notetypes.get(note.mid)
    if (!note || !type) {
      skipped++
      continue
    }
    const guid = `${note.guid}:${card.ord}`
    if (known.has(guid) || known.has(note.guid)) {
      skipped++
      continue
    }
    known.add(guid)
    todo.push({ card, note, type, guid })
  }

  // Blobs are durably stored before the transaction that references them.
  const blobIds = new Map<string, string>()
  for (const { note } of todo) {
    for (const name of note.fields.flatMap(mediaRefs)) {
      const data = media.get(name)
      if (data && !blobIds.has(name)) blobIds.set(name, await blobs.put(data, mimeOf(name)))
    }
  }
  const resolve = (name: string): string | null => blobIds.get(name) ?? null

  const prepared = todo.map((t) => {
    const sides = cardSides(t.note, t.type, t.card.ord)
    return {
      ...t,
      front: ankiToMarkdown(sides.front, resolve, convert),
      back: ankiToMarkdown(sides.back, resolve, convert),
    }
  })

  const revlogByCard = new Map<number, typeof collection.revlog>()
  for (const r of collection.revlog) {
    if (r.ease < 1 || r.ease > 4 || r.type === 4) continue
    const list = revlogByCard.get(r.cid) ?? []
    list.push(r)
    revlogByCard.set(r.cid, list)
  }

  let reviews = 0
  const courseIds: Id[] = []
  ws.batch(() => {
    const courses = new Map<string, Id>()
    for (const c of ws.courses.list()) if (!courses.has(c.title)) courses.set(c.title, c.id)
    const courseFor = (did: number): Id => {
      const title = courseTitle(collection.decks.get(did) ?? ['Anki'])
      let id = courses.get(title)
      if (!id) {
        id = ws.courses.create({ title })
        courses.set(title, id)
      }
      if (!courseIds.includes(id)) courseIds.push(id)
      return id
    }
    for (const p of prepared) {
      const id = ws.cards.create({
        courseId: courseFor(p.card.did),
        kind: p.type.kind === 'cloze' ? 'cloze' : 'basic',
        origin: 'anki',
        ankiGuid: p.guid,
        ...(p.note.tags.length > 0 ? { tags: p.note.tags } : {}),
        ...(p.card.queue === -1 ? { suspended: true } : {}),
      })
      ws.text({ id, field: 'front' }).insert(0, p.front)
      ws.text({ id, field: 'back' }).insert(0, p.back)
      if (opts.keepHistory === false) continue
      for (const r of revlogByCard.get(p.card.id) ?? []) {
        ws.reviews.record({ cardId: id, rating: r.ease as Rating, at: r.id, ms: r.time })
        reviews++
      }
    }
  })
  return { format, imported: prepared.length, skipped, reviews, media: blobIds.size, courseIds }
}
