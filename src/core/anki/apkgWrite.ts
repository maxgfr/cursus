import { sha1 } from '@noble/hashes/legacy.js'
import { zipSync } from 'fflate'
import type { BlobStore } from '../contracts/log'
import type { Id } from '../contracts/workspace'
import type { CardRecord } from '../model/schema'
import type { ModelWorkspace } from '../model/workspace'
import { type CardState, createScheduler, DAY_MS, type Phase } from '../srs/fsrs'
import { blobRefs, markdownToAnki } from './mdToAnki'
import { loadSql, SCHEMA11_DDL } from './schema11'

export const BASIC_ID = 1_600_000_000_001
export const CLOZE_ID = 1_600_000_000_002
export const ROOT_DECK = 'Cursus'

export interface ExportOptions {
  /** Courses to export (default: all live courses). */
  courseIds?: readonly Id[]
  /** Export time (epoch ms). */
  now: number
  /** Include review history (default true). */
  withHistory?: boolean
  desiredRetention?: number
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
}

const CSS = '.card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }'

function model(id: number, name: string, cloze: boolean, mod: number): Record<string, unknown> {
  const fields = cloze ? ['Text', 'Back Extra'] : ['Front', 'Back']
  const tmpl = cloze
    ? { qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Back Extra}}' }
    : { qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' }
  return {
    id,
    name,
    type: cloze ? 1 : 0,
    mod,
    usn: -1,
    sortf: 0,
    did: null,
    tmpls: [
      { name: cloze ? 'Cloze' : 'Card 1', ord: 0, ...tmpl, bqfmt: '', bafmt: '', did: null, bfont: '', bsize: 0 },
    ],
    flds: fields.map((f, ord) => ({ name: f, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    css: CSS,
    latexPre:
      '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
    latexPost: '\\end{document}',
    latexsvg: false,
    req: [[0, 'any', [0]]],
    tags: [],
    vers: [],
  }
}

function deck(id: number, name: string, mod: number): Record<string, unknown> {
  return {
    id,
    name,
    mod,
    usn: -1,
    lrnToday: [0, 0],
    revToday: [0, 0],
    newToday: [0, 0],
    timeToday: [0, 0],
    collapsed: false,
    browserCollapsed: false,
    desc: '',
    dyn: 0,
    conf: 1,
    extendNew: 0,
    extendRev: 0,
  }
}

function checksum(field: string): number {
  const plain = field.replace(/<[^>]*>/g, '')
  const h = sha1(new TextEncoder().encode(plain))
  return ((h[0] ?? 0) * 2 ** 24 + ((h[1] ?? 0) << 16) + ((h[2] ?? 0) << 8) + (h[3] ?? 0)) >>> 0
}

const REVLOG_TYPE: Record<Phase, number> = { new: 0, learning: 0, review: 1, relearning: 2 }

/** Anki interval: days for review cards, negative seconds while (re)learning. */
function interval(s: CardState, at: number): number {
  if (s.phase === 'review') return Math.max(1, Math.round((s.due - at) / DAY_MS))
  return -Math.max(1, Math.round((s.due - at) / 1000))
}

/**
 * Exports courses as a schema 11 `.apkg` ("Cursus Basic" / "Cursus Cloze" notetypes, one `Cursus::<course>`
 * deck per course and `Cursus::<course>::<subset>::…` per subset), with media, review history and FSRS due dates.
 */
export async function exportApkg(ws: ModelWorkspace, blobs: BlobStore, opts: ExportOptions): Promise<Uint8Array> {
  const now = opts.now
  const nowSecs = Math.floor(now / 1000)
  const sched = createScheduler({ desiredRetention: opts.desiredRetention ?? ws.prefs.get('desiredRetention') })
  const wanted = opts.courseIds ? new Set(opts.courseIds) : null
  const courses = ws.courses.list().filter((c) => !wanted || wanted.has(c.id))
  // Collection creation: midnight UTC of the export day minus a margin covering every review.
  const cards: CardRecord[] = courses.flatMap((c) => [...ws.cards.list({ courseId: c.id })])
  let earliest = now
  for (const c of cards) for (const r of ws.reviews.forCard(c.id)) if ('at' in r) earliest = Math.min(earliest, r.at)
  const crt = Math.floor((Math.floor(earliest / DAY_MS) * DAY_MS) / 1000)

  const SQL = await loadSql()
  const db = new SQL.Database()
  try {
    db.exec(SCHEMA11_DDL)
    const decks: Record<string, unknown> = { '1': deck(1, 'Default', nowSecs) }
    const rootId = now
    decks[String(rootId)] = deck(rootId, ROOT_DECK, nowSecs)
    // One deck per course and per live subset; names that collide once sanitised share one deck.
    const byName = new Map<string, number>()
    let nextDeck = rootId + 1
    const deckFor = (segments: readonly string[]): number => {
      const name = [ROOT_DECK, ...segments.map(deckSegment)].join('::')
      const key = name.toLowerCase()
      const known = byName.get(key)
      if (known !== undefined) return known
      const id = nextDeck++
      byName.set(key, id)
      decks[String(id)] = deck(id, name, nowSecs)
      return id
    }
    const tree = ws.sections.tree()
    const deckIds = new Map<Id, number>()
    const sectionDecks = new Map<Id, number>()
    for (const c of courses) {
      deckIds.set(c.id, deckFor([c.title]))
      const visit = (parentId: Id | null, path: readonly string[]): void => {
        for (const s of tree.children(c.id, parentId)) {
          const segs = [...path, s.name]
          sectionDecks.set(s.id, deckFor(segs))
          visit(s.id, segs)
        }
      }
      visit(null, [c.title])
    }
    const deckOf = (c: CardRecord): number => {
      const s = tree.sectionOf(c)
      return (s === null ? undefined : sectionDecks.get(s)) ?? deckIds.get(c.courseId) ?? 1
    }

    const mediaNames = new Map<string, string>()
    const mediaFiles: Record<string, Uint8Array> = {}
    const mediaJson: Record<string, string> = {}
    const nameOf = (id: string): string | null => mediaNames.get(id) ?? null
    for (const c of cards) {
      for (const field of ['front', 'back'] as const) {
        for (const id of blobRefs(ws.text({ id: c.id, field }).toString())) {
          if (mediaNames.has(id)) continue
          const blob = await blobs.get(id)
          if (!blob) continue
          const name = `cursus-${id.slice(0, 16)}.${EXT[blob.type] ?? 'bin'}`
          const member = String(mediaNames.size)
          mediaNames.set(id, name)
          mediaJson[member] = name
          mediaFiles[member] = new Uint8Array(await blob.arrayBuffer())
        }
      }
    }

    const insNote = db.prepare('insert into notes values (?,?,?,?,?,?,?,?,?,?,?)')
    const insCard = db.prepare('insert into cards values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    const insRev = db.prepare('insert into revlog values (?,?,?,?,?,?,?,?,?)')
    const usedRevIds = new Set<number>()
    let nextId = now
    let newPos = 0
    for (const c of cards) {
      const id = nextId++
      const front = markdownToAnki(ws.text({ id: c.id, field: 'front' }).toString(), nameOf)
      const back = markdownToAnki(ws.text({ id: c.id, field: 'back' }).toString(), nameOf)
      const cloze = c.kind === 'cloze'
      const ord = cloze ? Math.max(0, Number(/\{\{c(\d+)::/.exec(front)?.[1] ?? 1) - 1) : 0
      const tags = c.tags?.length ? ` ${c.tags.map((t) => t.replace(/\s+/g, '_')).join(' ')} ` : ''
      insNote.run([
        id,
        c.id,
        cloze ? CLOZE_ID : BASIC_ID,
        nowSecs,
        -1,
        tags,
        `${front}\x1f${back}`,
        front,
        checksum(front),
        0,
        '',
      ])

      const events = ws.reviews.forCard(c.id)
      const state = sched.replay(c.id, events)
      let type = 0
      let queue = 0
      let due = newPos++
      let ivl = 0
      if (state.phase === 'review') {
        type = 2
        queue = 2
        due = Math.floor((state.due / 1000 - crt) / 86_400)
        ivl = interval(state, state.lastReview ?? now)
      } else if (state.phase !== 'new') {
        type = state.phase === 'learning' ? 1 : 3
        queue = 1
        due = Math.floor(state.due / 1000)
      }
      if (c.suspended) queue = -1
      const data =
        state.phase === 'new' ? '' : JSON.stringify({ s: round(state.stability), d: round(state.difficulty) })
      insCard.run([
        id,
        id,
        deckOf(c),
        ord,
        nowSecs,
        -1,
        type,
        queue,
        due,
        ivl,
        2500,
        state.reps,
        state.lapses,
        0,
        0,
        0,
        0,
        data,
      ])

      if (opts.withHistory === false) continue
      const graded = events.filter((e) => 'rating' in e)
      let lastIvl = 0
      for (let i = 0; i < state.history.length; i++) {
        const step = state.history[i]
        if (!step) continue
        const after = sched.replay(c.id, graded.slice(0, i + 1))
        const ivlAfter = interval(after, step.at)
        let rid = step.at
        while (usedRevIds.has(rid)) rid++
        usedRevIds.add(rid)
        const ms = graded.find((e) => e.id === step.reviewId)
        const time = ms && 'ms' in ms ? Math.min(60_000, Math.round(ms.ms)) : 0
        insRev.run([rid, id, -1, step.rating, ivlAfter, lastIvl, 2500, time, REVLOG_TYPE[step.phaseBefore]])
        lastIvl = ivlAfter
      }
    }
    insNote.free()
    insCard.free()
    insRev.free()

    const models = {
      [String(BASIC_ID)]: model(BASIC_ID, 'Cursus Basic', false, nowSecs),
      [String(CLOZE_ID)]: model(CLOZE_ID, 'Cursus Cloze', true, nowSecs),
    }
    db.run('insert into col values (1,?,?,?,11,0,0,0,?,?,?,?,?)', [
      crt,
      now,
      now,
      JSON.stringify({ nextPos: newPos, curDeck: 1, schedVer: 2, sched2021: true }),
      JSON.stringify(models),
      JSON.stringify(decks),
      '{}',
      '{}',
    ])
    const collection = db.export()
    return zipSync({
      'collection.anki2': collection,
      media: new TextEncoder().encode(JSON.stringify(mediaJson)),
      ...mediaFiles,
    })
  } finally {
    db.close()
  }
}

/** One deck name segment: no `::` (the Anki separator), no surrounding blanks, never empty. */
function deckSegment(name: string): string {
  return name.replace(/::/g, ':').replace(/\s+/g, ' ').trim() || '-'
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000
}
