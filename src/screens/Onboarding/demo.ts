import { importDeck } from '../../core/content/deck'
import { photoMarkdown } from '../../core/content/photos'
import type { Clock, LocalStore } from '../../core/contracts/ports'
import type { Id, NewReview, NewSession, Rating, Weekday } from '../../core/contracts/workspace'
import { blobStore } from '../../core/log/blobs'
import type { NewDraft } from '../../core/model/drafts'
import { addPhoto, attachPhoto } from '../../core/model/photos'
import type { CardOrigin } from '../../core/model/schema'
import type { ModelWorkspace } from '../../core/model/workspace'
import type { Translate } from '../../i18n/index.ts'
import { storeDeckFiles } from '../DeckImport/deckSource.ts'
import { bilayerDiagram, cellSketch, deckPptx, microscopePhoto } from './demoFiles.ts'

/**
 * The demo course: a realistic course that shows every feature at once, written only when the student asks for
 * it. Two levels of subsets, an exam three weeks away, two notes (headings, a list, a table, maths), a slide
 * deck with speaker notes and a picture, two photos (one attached to a note, one on a card), cards of every kind,
 * two weeks of reviews (some due today, one being relearned), a counted session and a cramming one with a missed
 * card each, a weekly planned session, and questions proposed on the slides waiting in « To review ».
 *
 * Its files (deck, pictures, photos) are made here and stored first; then everything else is written in one
 * atomic write, so another device never sees half a demo, and a failure leaves nothing behind. It is an ordinary
 * course: it can be trashed and restored, and asking twice makes a second, independent one. Nothing here calls
 * an AI, reads the network or touches the student's other courses.
 */

export interface DemoDeps {
  ws: ModelWorkspace
  /** Where the deck and the photos are stored (before the write that names them). */
  store: LocalStore
  clock: Clock
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** The exam is three weeks away. */
export const DEMO_EXAM_DAYS = 21

type Place = 'root' | 'membranes' | 'structure' | 'transport' | 'organelles' | 'mito'

/**
 * Review histories, as (days ago, ratings given that day 10 minutes apart). Chosen so that whatever the card id
 * (FSRS fuzzes intervals by card), the time of day and the zone, exactly three cards are due today: one review
 * long overdue (`due`), one relearning since it was missed two days ago (`relearn`), and the one new card. Every
 * other card comes back two days from now or later (see demo.test.ts).
 */
const HISTORIES = {
  long: [
    [13, [3, 3]],
    [10, [3]],
    [2, [3]],
  ],
  easy: [
    [12, [4]],
    [3, [3]],
  ],
  lapse: [
    [14, [3, 3]],
    [11, [3]],
    [6, [1, 3]],
    [3, [3]],
  ],
  hard: [
    [13, [2, 3]],
    [9, [3]],
    [4, [3]],
  ],
  due: [[14, [3, 3]]],
  relearn: [
    [13, [3, 3]],
    [10, [3]],
    [2, [1]],
  ],
  new: [],
} as const satisfies Record<string, readonly (readonly [number, readonly Rating[]])[]>
type History = keyof typeof HISTORIES

/** The counted session of two days ago holds every review given that day. */
const SESSION_DAY = 2
/** The cramming session, four days ago in the evening: practice reviews of the transport subset. */
const CRAM_DAY = 4

interface CardSpec {
  at: Place
  kind: 'basic' | 'cloze'
  front: string
  back?: string
  /** The source it was written from, and the slide it cites. */
  source?: 'note' | 'note2' | 'deck' | 'sketch'
  unit?: number
  history: History
  /** Graded in the cramming session (1 = missed). */
  cram?: Rating
}

/** A question proposed on a slide, and what became of it (an accepted one is a card with a history). */
interface DraftSpec extends Omit<NewDraft, 'sourceId' | 'courseId' | 'sectionId' | 'unitKind' | 'unitLabel'> {
  at: Place
  fate: 'proposed' | 'accepted' | 'rejected'
  history?: History
  cram?: Rating
}

/** How long an answer took, made up but steady: 4 to 13 seconds. */
const answerMs = (i: number): number => 4_000 + ((i * 7_919) % 9_000)

/** Local `YYYY-MM-DD` of the study day `days` after the one of `now` (a study day starts at 04:00). */
function studyDate(now: number, days: number): string {
  const d = new Date(now - 4 * HOUR)
  d.setDate(d.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Lines of a catalog string (bullets, table rows). */
const lines = (s: string): string[] => s.split('\n').filter((l) => l.trim() !== '')

/**
 * Makes the demo course and returns its id. `language` is the course's language (read aloud, AI answers),
 * when the interface has one.
 */
export async function createDemoCourse(deps: DemoDeps, t: Translate, language?: string): Promise<Id> {
  const { ws, store, clock } = deps
  const now = clock.now()

  // --- Files, made and stored before anything names them ---
  const bilayer = bilayerDiagram()
  const slide2 = lines(t('today.demoSlide2Bullets'))
  const slide3 = lines(t('today.demoSlide3Table')).map((row) => row.split('|').map((c) => c.trim()))
  const slide4 = lines(t('today.demoSlide4Bullets'))
  const deckTitle = t('today.demoDeckTitle')
  const bytes = deckPptx(deckTitle, [
    { title: t('today.demoSlide1Title'), subtitle: t('today.demoSlide1Sub'), notes: t('today.demoSlide1Notes') },
    {
      title: t('today.demoSlide2Title'),
      bullets: slide2,
      image: { png: bilayer.bytes, alt: t('today.demoSlide2Alt') },
      notes: t('today.demoSlide2Notes'),
    },
    { title: t('today.demoSlide3Title'), table: slide3, notes: t('today.demoSlide3Notes') },
    { title: t('today.demoSlide4Title'), bullets: slide4, notes: t('today.demoSlide4Notes') },
  ])
  const deck = await importDeck(bytes, { name: `${deckTitle}.pptx` })
  const deckFields = await storeDeckFiles(store, { deck, bytes })
  const blobs = blobStore(store)
  const micro = microscopePhoto()
  const sketch = cellSketch()
  const microId = await blobs.put(micro.bytes, micro.mime)
  const sketchId = await blobs.put(sketch.bytes, sketch.mime)

  const sketchCaption = t('today.demoPhoto2Caption')
  const cards: CardSpec[] = [
    { at: 'root', kind: 'basic', front: t('today.demoQ01'), back: t('today.demoA01'), history: 'long' },
    {
      at: 'root',
      kind: 'basic',
      front: t('today.demoQ02'),
      back: t('today.demoA02'),
      source: 'note',
      history: 'easy',
    },
    {
      at: 'membranes',
      kind: 'basic',
      front: t('today.demoQ03'),
      back: t('today.demoA03'),
      source: 'deck',
      unit: 2,
      history: 'due',
    },
    { at: 'structure', kind: 'cloze', front: t('today.demoQ04'), source: 'deck', unit: 2, history: 'long' },
    {
      at: 'transport',
      kind: 'basic',
      front: t('today.demoQ06'),
      back: t('today.demoA06'),
      source: 'deck',
      unit: 3,
      history: 'lapse',
      cram: 3,
    },
    { at: 'transport', kind: 'basic', front: t('today.demoQ07'), back: t('today.demoA07'), history: 'long', cram: 1 },
    {
      at: 'transport',
      kind: 'cloze',
      front: t('today.demoQ08'),
      source: 'deck',
      unit: 3,
      history: 'relearn',
      cram: 3,
    },
    {
      at: 'transport',
      kind: 'basic',
      front: t('today.demoQ10'),
      back: t('today.demoA10'),
      source: 'note',
      history: 'hard',
      cram: 4,
    },
    {
      at: 'organelles',
      kind: 'basic',
      front: `${t('today.demoQ11')}\n\n${photoMarkdown(sketchId, sketchCaption)}`,
      back: t('today.demoA11'),
      source: 'sketch',
      history: 'new',
    },
    { at: 'organelles', kind: 'basic', front: t('today.demoQ12'), back: t('today.demoA12'), history: 'long' },
    { at: 'organelles', kind: 'cloze', front: t('today.demoQ13'), history: 'lapse' },
    {
      at: 'mito',
      kind: 'basic',
      front: t('today.demoQ14'),
      back: t('today.demoA14'),
      source: 'note2',
      history: 'easy',
    },
    {
      at: 'mito',
      kind: 'basic',
      front: t('today.demoQ15'),
      back: t('today.demoA15'),
      source: 'note2',
      history: 'hard',
    },
    { at: 'mito', kind: 'cloze', front: t('today.demoQ16'), source: 'note2', history: 'long' },
  ]
  /** Proposed on the slides (as the AI would have, written here): two accepted, one rejected, the rest to review. */
  const drafts: DraftSpec[] = [
    {
      at: 'structure',
      unit: 2,
      kind: 'basic',
      type: 'explain',
      difficulty: 'hard',
      front: t('today.demoQ05'),
      back: t('today.demoA05'),
      quote: slide2[1],
      fate: 'accepted',
      history: 'hard',
    },
    {
      at: 'transport',
      unit: 4,
      kind: 'basic',
      type: 'qa',
      difficulty: 'easy',
      front: t('today.demoQ09'),
      back: t('today.demoA09'),
      quote: slide4[1],
      fate: 'accepted',
      history: 'easy',
      cram: 3,
    },
    {
      at: 'structure',
      unit: 2,
      kind: 'basic',
      type: 'qa',
      difficulty: 'easy',
      front: t('today.demoD1Q'),
      back: t('today.demoD1A'),
      quote: slide2[0],
      fate: 'proposed',
    },
    {
      at: 'transport',
      unit: 3,
      kind: 'cloze',
      type: 'cloze',
      difficulty: 'medium',
      front: t('today.demoD2Q'),
      back: '',
      fate: 'proposed',
    },
    {
      at: 'transport',
      unit: 3,
      kind: 'basic',
      type: 'qa',
      difficulty: 'medium',
      front: t('today.demoD3Q'),
      back: t('today.demoD3A'),
      quote: slide3[2]?.join(' | '),
      fate: 'proposed',
    },
    {
      at: 'transport',
      unit: 4,
      kind: 'basic',
      type: 'explain',
      difficulty: 'hard',
      front: t('today.demoD4Q'),
      back: t('today.demoD4A'),
      quote: slide4[2],
      fate: 'proposed',
    },
    {
      at: 'transport',
      unit: 4,
      kind: 'basic',
      type: 'qa',
      difficulty: 'easy',
      front: t('today.demoD5Q'),
      back: t('today.demoD5A'),
      quote: slide4[0],
      fate: 'proposed',
    },
    {
      at: 'membranes',
      unit: 1,
      kind: 'basic',
      type: 'qa',
      difficulty: 'easy',
      front: t('today.demoR1Q'),
      back: t('today.demoR1A'),
      fate: 'rejected',
    },
  ]
  const texts = {
    course: t('today.demoCourse'),
    membranes: t('today.demoSecMembranes'),
    structure: t('today.demoSecStructure'),
    transport: t('today.demoSecTransport'),
    organelles: t('today.demoSecOrganelles'),
    mito: t('today.demoSecMito'),
    noteTitle: t('today.demoNoteTitle'),
    noteBody: t('today.demoNoteBody'),
    note2Title: t('today.demoNote2Title'),
    note2Body: t('today.demoNote2Body'),
    microTitle: t('today.demoPhoto1Title'),
    microCaption: t('today.demoPhoto1Caption'),
    sketchTitle: t('today.demoPhoto2Title'),
    plan: t('today.demoPlanName'),
  }

  // --- Everything else: one atomic write ---
  return ws.atomic(() => {
    const courseId = ws.courses.create({
      title: texts.course,
      examDate: studyDate(now, DEMO_EXAM_DAYS),
      ...(language === undefined ? {} : { language }),
    })
    const section = (name: string, parentId?: Id) =>
      ws.sections.create({ courseId, name, ...(parentId === undefined ? {} : { parentId }) })
    const membranes = section(texts.membranes)
    const organelles = section(texts.organelles)
    const places: Record<Place, Id | undefined> = {
      root: undefined,
      membranes,
      structure: section(texts.structure, membranes),
      transport: section(texts.transport, membranes),
      organelles,
      mito: section(texts.mito, organelles),
    }
    const where = (at: Place) => {
      const sectionId = places[at]
      return sectionId === undefined ? { courseId } : { courseId, sectionId }
    }

    const note = (at: Place, title: string, body: string) => {
      const id = ws.sources.create({ ...where(at), kind: 'note', title })
      ws.text({ id, field: 'body' }).insert(0, body)
      return id
    }
    const sources = {
      note: note('root', texts.noteTitle, texts.noteBody),
      note2: note('mito', texts.note2Title, texts.note2Body),
      deck: ws.sources.create({ ...where('membranes'), ...deckFields, title: deckTitle }),
      sketch: addPhoto(ws, {
        ...where('organelles'),
        title: texts.sketchTitle,
        blobId: sketchId,
        width: sketch.width,
        height: sketch.height,
        caption: sketchCaption,
      }),
    }
    const microPhoto = addPhoto(ws, {
      ...where('root'),
      title: texts.microTitle,
      blobId: microId,
      width: micro.width,
      height: micro.height,
      caption: texts.microCaption,
    })
    attachPhoto(ws, microPhoto, sources.note)

    const made: { id: Id; history: History; cram?: Rating }[] = []
    for (const c of cards) {
      const origin: CardOrigin = c.kind === 'cloze' ? 'cloze' : 'manual'
      const id = ws.cards.create({
        ...where(c.at),
        kind: c.kind,
        origin,
        ...(c.source === undefined ? {} : { sourceId: sources[c.source] }),
        ...(c.unit === undefined ? {} : { unit: c.unit }),
      })
      ws.text({ id, field: 'front' }).insert(0, c.front)
      if (c.back !== undefined) ws.text({ id, field: 'back' }).insert(0, c.back)
      made.push({ id, history: c.history, ...(c.cram === undefined ? {} : { cram: c.cram }) })
    }

    const ids = ws.drafts.propose(
      drafts.map(
        (d): NewDraft => ({
          ...where(d.at),
          sourceId: sources.deck,
          unit: d.unit,
          unitKind: 'slide',
          unitLabel: String(d.unit),
          kind: d.kind,
          type: d.type,
          front: d.front,
          back: d.back,
          ...(d.difficulty === undefined ? {} : { difficulty: d.difficulty }),
          ...(d.quote === undefined ? {} : { quote: d.quote }),
        }),
      ),
    )
    for (const [i, d] of drafts.entries()) {
      const id = ids[i]
      if (id === undefined) continue
      if (d.fate === 'rejected') ws.drafts.reject(id)
      if (d.fate !== 'accepted') continue
      made.push({
        id: ws.drafts.accept(id),
        history: d.history ?? 'new',
        ...(d.cram === undefined ? {} : { cram: d.cram }),
      })
    }

    // Two weeks of reviews; those of two days ago form one counted session.
    const counted: NewReview[] = []
    const reviews: NewReview[] = []
    for (const [i, card] of made.entries()) {
      for (const [days, ratings] of HISTORIES[card.history]) {
        for (const [k, rating] of ratings.entries()) {
          const r = { cardId: card.id, rating, at: now - days * DAY + i * MIN + k * 10 * MIN, ms: answerMs(i + k) }
          if (days === SESSION_DAY) counted.push(r)
          else reviews.push(r)
        }
      }
    }
    // Past sessions, at the times they took place.
    const past = (s: NewSession, from: number, to: number): Id => {
      const id = ws.sessions.start(s, from)
      ws.sessions.end(id, to)
      return id
    }
    const countedAt = now - SESSION_DAY * DAY
    const countedId = past(
      { scope: { courseId }, kind: 'due', practice: false },
      countedAt - MIN,
      countedAt + made.length * MIN + 2 * MIN,
    )
    const cramAt = now - CRAM_DAY * DAY + 3 * HOUR
    const crammed = made.filter((c) => c.cram !== undefined)
    const cramId = past(
      { scope: where('transport'), kind: 'all', practice: true },
      cramAt,
      cramAt + crammed.length * MIN + MIN,
    )
    ws.reviews.recordMany([
      ...reviews,
      ...counted.map((r) => ({ ...r, sid: countedId })),
      ...crammed.map((c, i) => ({
        cardId: c.id,
        rating: c.cram ?? 3,
        at: cramAt + (i + 1) * MIN,
        ms: answerMs(i),
        sid: cramId,
        p: true as const,
      })),
    ])

    const weekdays: Weekday[] = [2, 5]
    ws.plans.create({ name: texts.plan, courseId, kind: 'due', weekdays, time: '18:00', practice: false })
    return courseId
  })
}
