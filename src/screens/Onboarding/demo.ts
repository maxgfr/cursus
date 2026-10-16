import { type DeckUnit, importDeck } from '../../core/content/deck'
import { photoMarkdown } from '../../core/content/photos'
import type { Clock, LocalStore } from '../../core/contracts/ports'
import type { Id, NewReview, NewSession, Rating, Weekday } from '../../core/contracts/workspace'
import { blobRef, blobStore } from '../../core/log/blobs'
import type { NewDraft } from '../../core/model/drafts'
import { addPhoto, attachPhoto } from '../../core/model/photos'
import type { CardOrigin, DraftUnitKind } from '../../core/model/schema'
import type { ModelWorkspace } from '../../core/model/workspace'
import { createTranslator, type Locale, loadCatalog, type Translate } from '../../i18n/index.ts'
import { storeDeckFiles } from '../DeckImport/deckSource.ts'
import { bilayerDiagram, cellSketch, deckPptx, documentDocx, microscopePhoto, textPdf } from './demoFiles.ts'

/**
 * The demo course: a realistic course that shows every feature at once, written only when the student asks for
 * it. Two levels of subsets (one with its own midterm, one in the trash), an exam three weeks away; notes
 * (headings, lists, a table, maths, code, a link) and a pasted one; a slide deck with speaker notes and a
 * picture; a Word lab handout read by section; a past paper read page by page and a syllabus kept as a plain
 * PDF; two photos (one attached to a note, one on a card, with its own notes); a study sheet in two subsets;
 * cards of every kind; two weeks of reviews (some due today, one being relearned); a planned counted session, a
 * cramming one and its relaunch over the missed card; two planned sessions (one a practice over a subset); and
 * cards the student asked AI to suggest on the slides, the handout and a photo, waiting in « Suggested cards ».
 *
 * Its files (deck, document, PDFs, pictures, photos) are made here and stored first; then everything else is
 * written in one atomic write, so another device never sees half a demo, and a failure leaves nothing behind. It
 * is an ordinary course: it can be trashed and restored, and asking twice makes a second, independent one.
 * Nothing here calls an AI, reads the network or touches the student's other courses.
 */

export interface DemoDeps {
  ws: ModelWorkspace
  /** Where the files are stored (before the write that names them). */
  store: LocalStore
  clock: Clock
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** The exam is three weeks away. */
export const DEMO_EXAM_DAYS = 21
/** The membranes subset has its own midterm, before the exam. */
export const DEMO_MIDTERM_DAYS = 10

/**
 * The translator the demo's content is written with: the interface's, except under the pseudo-locale, whose
 * accented text would break the content's Markdown, maths and fill-in-the-blanks (it checks the interface, not
 * the course): there, the content is the English one.
 */
export async function demoTranslator(locale: Locale): Promise<Translate> {
  const content = locale === 'pseudo' ? 'en' : locale
  await loadCatalog(content)
  return createTranslator(content)
}

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

/** The counted session of two days ago holds every review given that day, at the weekly plan's time. */
const SESSION_DAY = 2
const PLAN_TIME = { hour: 18, minute: 0 }
/** The cramming session, four days ago in the evening: practice reviews of the transport subset. */
const CRAM_DAY = 4
const CRAM_TIME = { hour: 20, minute: 30 }
/** A photo is read as a single unit (as `PHOTO_UNIT` of the photo question generator). */
const PHOTO_UNIT = 1

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

/** A proposed question, and what became of it (an accepted one is a card with a history). */
interface DraftSpec extends Omit<NewDraft, 'sourceId' | 'courseId' | 'sectionId' | 'unit' | 'unitKind' | 'unitLabel'> {
  at: Place
  /** The source it was proposed on: a slide of the deck, a section of the handout, or the sketch. */
  on: { source: 'deck'; slide: number } | { source: 'doc'; unit: DeckUnit } | { source: 'sketch' }
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

/** The local instant at `time` on the study day `days` after the one of `now`. */
function studyDayAt(now: number, days: number, time: { hour: number; minute: number }): number {
  const d = new Date(now - 4 * HOUR)
  d.setDate(d.getDate() + days)
  d.setHours(time.hour, time.minute, 0, 0)
  return d.getTime()
}

/** ISO weekday (1 = Monday) of an instant, in local time. */
const ISO_WEEKDAY: readonly Weekday[] = [7, 1, 2, 3, 4, 5, 6]
const weekdayOf = (at: number): Weekday => ISO_WEEKDAY[new Date(at).getDay()] ?? 1

/** Lines of a catalog string (bullets, table rows). */
const lines = (s: string): string[] => s.split('\n').filter((l) => l.trim() !== '')
/** Rows of a catalog table (`a | b | c` per line). */
const rows = (s: string): string[][] => lines(s).map((row) => row.split('|').map((c) => c.trim()))

/** A title as a read document gives it back: its white space (no-break spaces too) as single spaces. */
const asRead = (title: string): string => title.replace(/\s+/g, ' ')

/** The unit of a read document with this title (made here: it is there). */
function unitTitled(units: readonly DeckUnit[], title: string): DeckUnit {
  const unit = units.find((u) => u.title === asRead(title))
  if (unit === undefined) throw new Error(`the demo document has no section « ${title} »`)
  return unit
}

/**
 * Makes the demo course and returns its id. `t` writes its content (see `demoTranslator`); `language` is the
 * course's language (read aloud, AI answers), when the interface has one.
 */
export async function createDemoCourse(deps: DemoDeps, t: Translate, language?: string): Promise<Id> {
  const { ws, store, clock } = deps
  const now = clock.now()

  // --- Files, made and stored before anything names them ---
  const bilayer = bilayerDiagram()
  const slide2 = lines(t('today.demoSlide2Bullets'))
  const slide3 = rows(t('today.demoSlide3Table'))
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

  // The lab handout, read section by section.
  const docTitle = t('today.demoDocTitle')
  const results = rows(t('today.demoDocResults'))
  const docBytes = documentDocx(docTitle, t('today.demoDocIntro'), [
    { title: t('today.demoDocAimTitle'), level: 1, text: t('today.demoDocAim') },
    { title: t('today.demoDocMethodTitle'), level: 1, bullets: lines(t('today.demoDocMethod')) },
    { title: t('today.demoDocSafetyTitle'), level: 2, text: t('today.demoDocSafety') },
    { title: t('today.demoDocResultsTitle'), level: 1, table: results },
  ])
  const doc = await importDeck(docBytes, { name: `${docTitle}.docx` })
  const docFields = await storeDeckFiles(store, { deck: doc, bytes: docBytes })
  const resultsUnit = unitTitled(doc.units, t('today.demoDocResultsTitle'))

  // A past paper read page by page (a PDF of pages is a document); a syllabus kept as a file, to read in the app
  // on request. pdf.js reads them when they are opened, never here.
  const blobs = blobStore(store)
  const paperTitle = t('today.demoPdfTitle')
  const paperId = await blobs.put(
    textPdf(paperTitle, [t('today.demoPdfPage1').split('\n'), t('today.demoPdfPage2').split('\n')]),
    'application/pdf',
  )
  const syllabusTitle = t('today.demoSyllabusTitle')
  const syllabusId = await blobs.put(textPdf(syllabusTitle, [t('today.demoSyllabus').split('\n')]), 'application/pdf')

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
  /**
   * Suggested when asked (as the AI would have, written here) on the slides, a section of the handout and the sketch: two
   * accepted, one rejected, the rest to review.
   */
  const drafts: DraftSpec[] = [
    {
      at: 'structure',
      on: { source: 'deck', slide: 2 },
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
      on: { source: 'deck', slide: 4 },
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
      on: { source: 'deck', slide: 2 },
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
      on: { source: 'deck', slide: 3 },
      kind: 'cloze',
      type: 'cloze',
      difficulty: 'medium',
      front: t('today.demoD2Q'),
      back: '',
      fate: 'proposed',
    },
    {
      at: 'transport',
      on: { source: 'deck', slide: 3 },
      kind: 'basic',
      type: 'qa',
      difficulty: 'medium',
      front: t('today.demoD3Q'),
      back: t('today.demoD3A'),
      // A quote is a passage copied as is: the table's cell that answers, not its row's Markdown.
      quote: slide3[2]?.[2],
      fate: 'proposed',
    },
    {
      at: 'transport',
      on: { source: 'deck', slide: 4 },
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
      on: { source: 'deck', slide: 4 },
      kind: 'basic',
      type: 'qa',
      difficulty: 'easy',
      front: t('today.demoD5Q'),
      back: t('today.demoD5A'),
      quote: slide4[0],
      fate: 'proposed',
    },
    {
      at: 'transport',
      on: { source: 'doc', unit: resultsUnit },
      kind: 'basic',
      type: 'qa',
      difficulty: 'medium',
      front: t('today.demoD6Q'),
      back: t('today.demoD6A'),
      quote: results[3]?.[2],
      fate: 'proposed',
    },
    {
      at: 'organelles',
      on: { source: 'sketch' },
      kind: 'basic',
      type: 'qa',
      difficulty: 'medium',
      front: t('today.demoD7Q'),
      back: t('today.demoD7A'),
      fate: 'proposed',
    },
    {
      at: 'membranes',
      on: { source: 'deck', slide: 1 },
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
    old: t('today.demoSecOld'),
    noteTitle: t('today.demoNoteTitle'),
    noteBody: t('today.demoNoteBody'),
    note2Title: t('today.demoNote2Title'),
    note2Body: t('today.demoNote2Body'),
    pastedTitle: t('course.pastedNote'),
    pastedBody: t('today.demoPastedBody'),
    microTitle: t('today.demoPhoto1Title'),
    microCaption: t('today.demoPhoto1Caption'),
    sketchTitle: t('today.demoPhoto2Title'),
    sketchNotes: t('today.demoPhoto2Notes'),
    sheet1Title: t('today.demoSheet1Title'),
    sheet1Body: t('today.demoSheet1Body', { deck: deckTitle, lab: docTitle }),
    sheet2Title: t('today.demoSheet2Title'),
    sheet2Body: t('today.demoSheet2Body', { note: t('today.demoNote2Title') }),
    plan: t('today.demoPlanName'),
    plan2: t('today.demoPlan2Name'),
  }

  // --- Everything else: one atomic write ---
  return ws.atomic(() => {
    const courseId = ws.courses.create({
      title: texts.course,
      examDate: studyDate(now, DEMO_EXAM_DAYS),
      ...(language === undefined ? {} : { language }),
    })
    const section = (name: string, parentId?: Id, examDate?: string) =>
      ws.sections.create({
        courseId,
        name,
        ...(parentId === undefined ? {} : { parentId }),
        ...(examDate === undefined ? {} : { examDate }),
      })
    const membranes = section(texts.membranes, undefined, studyDate(now, DEMO_MIDTERM_DAYS))
    const organelles = section(texts.organelles)
    const places: Record<Place, Id | undefined> = {
      root: undefined,
      membranes,
      structure: section(texts.structure, membranes),
      transport: section(texts.transport, membranes),
      organelles,
      mito: section(texts.mito, organelles),
    }
    // An empty subset left in the trash, to restore from the course or the Trash.
    ws.sections.trash(section(texts.old))
    const where = (at: Place) => {
      const sectionId = places[at]
      return sectionId === undefined ? { courseId } : { courseId, sectionId }
    }

    const note = (at: Place, title: string, body: string) => {
      const id = ws.sources.create({ ...where(at), kind: 'note', title })
      ws.text({ id, field: 'body' }).insert(0, body)
      return id
    }
    const sketchPhoto = addPhoto(ws, {
      ...where('organelles'),
      title: texts.sketchTitle,
      blobId: sketchId,
      width: sketch.width,
      height: sketch.height,
      caption: sketchCaption,
    })
    ws.text({ id: sketchPhoto, field: 'body' }).insert(0, texts.sketchNotes)
    const sources = {
      note: note('root', texts.noteTitle, texts.noteBody),
      note2: note('mito', texts.note2Title, texts.note2Body),
      deck: ws.sources.create({ ...where('membranes'), ...deckFields, title: deckTitle }),
      doc: ws.sources.create({ ...where('transport'), ...docFields, title: docTitle }),
      sketch: sketchPhoto,
    }
    note('membranes', texts.pastedTitle, texts.pastedBody)
    ws.sources.create({
      ...where('structure'),
      kind: 'pdf',
      support: 'document',
      title: paperTitle,
      blobId: paperId,
      blobIds: [blobRef(paperId)],
    })
    ws.sources.create({ ...where('root'), kind: 'pdf', title: syllabusTitle, blobId: syllabusId })
    const microPhoto = addPhoto(ws, {
      ...where('root'),
      title: texts.microTitle,
      blobId: microId,
      width: micro.width,
      height: micro.height,
      caption: texts.microCaption,
    })
    attachPhoto(ws, microPhoto, sources.note)

    // Study sheets, as « Understand » saves them: a summary, then a heading per point with its source.
    const sheet = (at: Place, title: string, body: string, sourceIds: Id[]) => {
      const id = ws.fiches.create({ ...where(at), title, sourceIds })
      ws.text({ id, field: 'body' }).insert(0, body)
    }
    sheet('membranes', texts.sheet1Title, texts.sheet1Body, [sources.deck, sources.doc])
    sheet('mito', texts.sheet2Title, texts.sheet2Body, [sources.note2])

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

    const unitOf = (on: DraftSpec['on']): { unit: number; unitKind?: DraftUnitKind; unitLabel?: string } => {
      if (on.source === 'deck') return { unit: on.slide, unitKind: 'slide', unitLabel: String(on.slide) }
      if (on.source === 'doc') return { unit: on.unit.index, unitKind: 'section', unitLabel: on.unit.label }
      return { unit: PHOTO_UNIT }
    }
    const ids = ws.drafts.propose(
      drafts.map(
        (d): NewDraft => ({
          ...where(d.at),
          sourceId: sources[d.on.source],
          ...unitOf(d.on),
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

    // Planned sessions: the weekly review (two days ago was one of its days), and a practice over the midterm's
    // subset, later in the week.
    const countedAt = studyDayAt(now, -SESSION_DAY, PLAN_TIME)
    const pad = (n: number) => String(n).padStart(2, '0')
    const weekly = ws.plans.create({
      name: texts.plan,
      courseId,
      kind: 'due',
      weekdays: [weekdayOf(countedAt), weekdayOf(now + DAY)].sort((a, b) => a - b),
      time: `${pad(PLAN_TIME.hour)}:${pad(PLAN_TIME.minute)}`,
      practice: false,
    })
    ws.plans.create({
      name: texts.plan2,
      ...where('membranes'),
      kind: 'ahead',
      limit: 20,
      weekdays: [weekdayOf(now + 3 * DAY)],
      time: '17:30',
      practice: true,
    })

    // Two weeks of reviews; those of two days ago form one counted session, started from the weekly plan at its
    // time, one card a minute.
    const counted: NewReview[] = []
    const reviews: NewReview[] = []
    for (const [i, card] of made.entries()) {
      for (const [days, ratings] of HISTORIES[card.history]) {
        for (const [k, rating] of ratings.entries()) {
          const ms = answerMs(i + k)
          if (days === SESSION_DAY)
            counted.push({ cardId: card.id, rating, at: countedAt + (counted.length + 1) * MIN, ms })
          else reviews.push({ cardId: card.id, rating, at: now - days * DAY + i * MIN + k * 10 * MIN, ms })
        }
      }
    }
    // Past sessions, at the times they took place.
    const past = (s: NewSession, from: number, to: number): Id => {
      const id = ws.sessions.start(s, from)
      ws.sessions.end(id, to)
      return id
    }
    const countedId = past(
      { scope: { courseId }, kind: 'due', practice: false, planId: weekly },
      countedAt,
      countedAt + (counted.length + 1) * MIN,
    )
    const cramAt = studyDayAt(now, -CRAM_DAY, CRAM_TIME)
    const crammed = made.filter((c) => c.cram !== undefined)
    const cramEnd = cramAt + crammed.length * MIN + MIN
    const cramId = past({ scope: where('transport'), kind: 'all', practice: true }, cramAt, cramEnd)
    // Right after, the missed card again (« Go over the forgotten ones »): recalled this time.
    const missed = crammed.filter((c) => c.cram === 1)
    const relaunchAt = cramEnd + 2 * MIN
    const relaunchId = past(
      { scope: where('transport'), kind: 'failed', practice: true, cardIds: missed.map((c) => c.id) },
      relaunchAt,
      relaunchAt + missed.length * MIN + MIN,
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
      ...missed.map((c, i) => ({
        cardId: c.id,
        rating: 3 as const,
        at: relaunchAt + (i + 1) * MIN,
        ms: answerMs(i + 3),
        sid: relaunchId,
        p: true as const,
      })),
    ])
    return courseId
  })
}
