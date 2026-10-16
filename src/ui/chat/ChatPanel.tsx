import { Check, Copy, History, Plus, SquarePen, Trash2, X } from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link, useLocation } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspace } from '../../app/workspaceContext.tsx'
import {
  type Conversation,
  clearConversations,
  deleteConversation,
  listConversations,
  saveConversation,
} from '../../core/ai/chatStore'
import { VisionRequiredError } from '../../core/ai/features/describePhoto'
import { explainCard } from '../../core/ai/features/explainCard'
import { EXPLAIN_OUTPUT_TOKENS, explainQuestion } from '../../core/ai/features/explainQuestion'
import {
  buildTutorTurn,
  type CardRich,
  type ChatContext,
  type ChatIntent,
  type ChatMessage,
  type ChatSegment,
  guardReply,
  isCardRich,
  keepValidCitations,
  parseCitations,
  type RichResult,
  richText,
  type StudyOptions,
  tutorChat,
} from '../../core/ai/features/tutorChat'
import type { Chunk } from '../../core/ai/retrieval'
import type {
  CardDraft,
  CardExplanation,
  CardImprovement,
  PhotoDescription,
  QuestionExplanationDraft,
  QuizQuestion,
  SourceRef,
  Understanding,
} from '../../core/ai/schemas'
import { renderPhoto } from '../../core/content/photos'
import type { StudyScope } from '../../core/contracts/workspace'
import { getPhoto } from '../../core/model/photos'
import type { ModelWorkspace } from '../../core/model/workspace'
import { formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { createFiche, WRITE_QUERY } from '../../screens/Fiche/create.ts'
import { useFileLoader } from '../../screens/Photos/files.ts'
import { newQuizRun, saveQuizRun } from '../../screens/Quiz/run.ts'
import { describeFailure } from '../../screens/Review/failure.ts'
import { cardText, passagesText, useAiModel } from '../../screens/Understand/shared/aiConfig.ts'
import { Citation } from '../../screens/Understand/shared/SourcePicker.tsx'
import { estimateCost } from '../../screens/Understand/shared/sources.ts'
import { Button, buttonClass } from '../components/Button.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { cx } from '../cx.ts'
import { proposeFor } from '../data/autoQuestions.ts'
import { usePartial } from '../data/usePartial.ts'
import { useCanCallAi } from '../ExplainLauncher.tsx'
import { Sanitized } from '../render/Sanitized.tsx'
import { actionById, actionsFor, type ChatAction, type StudyKind } from './actions.ts'
import styles from './ChatPanel.module.css'
import { type ScreenContext, useChat } from './context.tsx'
import { ResizeHandle } from './ResizeHandle.tsx'
import { keyed, PartialRich, RichAnswer, RichNote } from './RichAnswer.tsx'
import {
  AttachedPhoto,
  PartialCards,
  PartialGrade,
  PartialImprove,
  PartialPhoto,
  PartialQuiz,
  PartialSheet,
  StudyAnswer,
  type StudyApi,
  StudyProvider,
} from './StudyAnswer.tsx'
import {
  checkExplanation,
  chunkLoader,
  type PhotoImages,
  PhotoUnavailableError,
  type Run,
  runGrade,
  runImprove,
  runPhoto,
  runPhotoCards,
  runStudy,
  type StudyDeps,
  startOptions,
} from './studyRun.ts'

const DOCKED = '(min-width: 1000px)'
/** Room left above a structured answer scrolled to its start. */
const SCROLL_MARGIN = 12

function useDocked(): boolean {
  const [docked, setDocked] = useState(() => window.matchMedia(DOCKED).matches)
  useEffect(() => {
    const mq = window.matchMedia(DOCKED)
    const on = () => setDocked(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return docked
}

/**
 * The chat beside the screens: docked on the right from 1000px, below it a sheet over the page (the whole screen on
 * phones, a full-height panel on the right from 600px). Loaded on first opening.
 */
export default function ChatPanel() {
  const t = useT()
  const chat = useChat()
  const docked = useDocked()
  if (!chat) return null
  if (docked) {
    // Closed, it stays mounted (hidden): the conversation is still there when it opens again.
    return (
      <aside className={styles.docked} aria-label={t('chat.title')} hidden={!chat.open}>
        <ResizeHandle />
        <ChatBody docked onClose={chat.close} />
      </aside>
    )
  }
  return (
    <Sheet open={chat.open} title={t('chat.title')} onClose={chat.close} fill>
      <ResizeHandle />
      <ChatBody docked={false} onClose={chat.close} />
    </Sheet>
  )
}

/** The screen's context with titles, as the tutor is told it. */
function describeContext(ws: ModelWorkspace, c: ScreenContext): ChatContext {
  const course = c.courseId ? ws.courses.get(c.courseId) : undefined
  const section = c.sectionId ? ws.sections.get(c.sectionId) : undefined
  const source = c.sourceId ? ws.sources.get(c.sourceId) : undefined
  return {
    ...(course ? { courseTitle: course.title } : {}),
    ...(section ? { sectionTitle: section.name } : {}),
    ...(source ? { sourceTitle: source.title } : {}),
    ...(c.card ? { card: c.card } : {}),
    ...(c.question ? { question: c.question } : {}),
  }
}

interface Live {
  text: string
  chunks: Chunk[]
}

/** A structured answer being written: which one, about which card. */
interface LiveRich {
  kind: CardRich['kind']
  card: { front: string; back: string; revealed: boolean }
}

/** A study answer being written: which one, in place of which answer (run again) or below the thread. */
interface LiveStudy {
  kind: RichResult['kind']
  replacing: string | null
  card?: { front: string; back: string }
}

/** One run of a study answer: the student's turn it answers (none when run again in place), and the work. */
interface StudyRunSpec {
  kind: RichResult['kind']
  label?: string
  photoId?: string
  replacing?: string
  card?: { front: string; back: string }
  work: (run: Run) => Promise<RichResult | null>
  /** Done once the answer is in the thread (a grade handed to the card on screen). */
  done?: (rich: RichResult) => void
}

const STUDY_KIND: Record<StudyKind, RichResult['kind']> = { generate: 'cards', quiz: 'quiz', understand: 'sheet' }

type Streamed = 'cards' | 'quiz' | 'sheet' | 'grade' | 'photo' | 'improve'

/** Where a kind of answer streams what it has written so far; nothing for the others. */
function onPartialOf(on: Record<Streamed, (p: unknown) => void>, kind: RichResult['kind']): (p: unknown) => void {
  switch (kind) {
    case 'cards':
    case 'quiz':
    case 'sheet':
    case 'grade':
    case 'photo':
    case 'improve':
      return on[kind]
    default:
      return () => undefined
  }
}

/** The course or section of a study action's options. */
const placeOf = (o: Pick<StudyOptions, 'courseId' | 'sectionId'>): StudyScope =>
  o.sectionId ? { courseId: o.courseId, sectionId: o.sectionId } : { courseId: o.courseId }

/** A photo's pixels as sent to a model: fetched if it is not here yet, turned upright, at most 1024 px. */
function usePhotoImages(): PhotoImages {
  const ws = useWorkspace()
  const loadFile = useFileLoader()
  return useCallback(
    async (id: string) => {
      const photo = getPhoto(ws, id)
      const file = photo ? await loadFile(photo.blobId) : null
      if (!photo || !file) throw new PhotoUnavailableError(id)
      const small = await renderPhoto(file, photo.rotation, 1024)
      return { bytes: new Uint8Array(await small.arrayBuffer()), mediaType: small.type || 'image/jpeg' }
    },
    [ws, loadFile],
  )
}

type Card = NonNullable<ScreenContext['card']>

/** Whether a structured answer about `faces` may show in full: always, unless that card is on screen unrevealed. */
const revealedFor = (faces: { front: string; back: string }, card: ScreenContext['card']) =>
  !(card && !card.revealed && card.front === faces.front && card.back === faces.back)

function ChatBody({ docked, onClose }: { docked: boolean; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const ws = useWorkspace()
  const rt = useRuntime()
  const chat = useChat()
  const ai = useAiModel()
  const callable = useCanCallAi(ai)
  const screen = chat?.context ?? {}
  const screenKey = JSON.stringify(screen)
  const [detached, setDetached] = useState<string | null>(null)
  // Removing the context lasts until the screen shows something else.
  const screenOn = detached !== screenKey
  const context: ScreenContext = screenOn ? screen : {}
  const courseId = screen.courseId
  const course = courseId ? ws.courses.get(courseId) : undefined

  const [chats, setChats] = useState<Conversation[]>([])
  const [current, setCurrent] = useState<{ id: string; messages: ChatMessage[]; courseId?: string }>(() => ({
    id: rt.rng.id(),
    messages: [],
    ...(courseId ? { courseId } : {}),
  }))
  const [showHistory, setShowHistory] = useState(false)
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState<Live | null>(null)
  const [liveRich, setLiveRich] = useState<LiveRich | null>(null)
  const [courseChunks, setCourseChunks] = useState<Chunk[]>([])
  const questionStream = usePartial<QuestionExplanationDraft>()
  const answerStream = usePartial<CardExplanation>()
  // What a study answer has written so far, one stream per kind of answer.
  const cardsStream = usePartial<{ cards: CardDraft[] }>()
  const quizStream = usePartial<{ questions: QuizQuestion[] }>()
  const sheetStream = usePartial<Understanding>()
  const gradeStream = usePartial<{ feedback: string }>()
  const photoStream = usePartial<PhotoDescription>()
  const improveStream = usePartial<CardImprovement>()
  const onPartials = {
    cards: cardsStream.onPartial,
    quiz: quizStream.onPartial,
    sheet: sheetStream.onPartial,
    grade: gradeStream.onPartial,
    photo: photoStream.onPartial,
    improve: improveStream.onPartial,
  }
  const resets = [
    cardsStream.reset,
    quizStream.reset,
    sheetStream.reset,
    gradeStream.reset,
    photoStream.reset,
    improveStream.reset,
  ]
  const streams = useRef({ onPartials, resets })
  streams.current = { onPartials, resets }
  const [liveStudy, setLiveStudy] = useState<LiveStudy | null>(null)
  /** The card whose answer the student is typing in their own words, in place of a question. */
  const [answering, setAnswering] = useState<NonNullable<ScreenContext['card']> | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The error asks for another model (one that reads images): the AI settings are offered. */
  const [needsSettings, setNeedsSettings] = useState(false)
  const retryRun = useRef<StudyRunSpec | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const images = usePhotoImages()
  const load = useMemo(() => chunkLoader(ws, rt), [ws, rt])
  const abort = useRef<AbortController | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const actionList = useRef<HTMLUListElement>(null)
  const [actionsMore, setActionsMore] = useState<'start' | 'end' | 'both' | null>(null)
  const measureActions = useCallback(() => {
    const el = actionList.current
    if (!el) return
    const before = el.scrollLeft > 1
    const after = el.scrollWidth - el.clientWidth - el.scrollLeft > 1
    setActionsMore(before && after ? 'both' : before ? 'start' : after ? 'end' : null)
  }, [])
  useEffect(() => {
    const el = actionList.current
    if (!el || typeof ResizeObserver === 'undefined') return
    measureActions()
    const seen = new ResizeObserver(measureActions)
    seen.observe(el)
    return () => seen.disconnect()
  })

  useEffect(() => () => abort.current?.abort(), [])

  // Conversations are kept per course: another course opens on a new chat, its earlier ones listed.
  useEffect(() => {
    let alive = true
    listConversations(rt.store, courseId).then(
      (list) => alive && setChats(list),
      (e: unknown) => console.warn('chats unavailable', e),
    )
    setCurrent((c) =>
      c.courseId === courseId ? c : { id: rt.rng.id(), messages: [], ...(courseId ? { courseId } : {}) },
    )
    return () => {
      alive = false
    }
  }, [rt, courseId])

  // The question box takes the focus on opening, or as soon as it shows once the model is known.
  const status = ai.status
  useEffect(() => {
    if (chat?.open && status === 'ready') input.current?.focus({ preventScroll: true })
  }, [chat?.open, status])

  // A new message or the panel opening shows the end of the thread, except a structured answer just in, which
  // shows from its start (its heading, its first drafts) when it is taller than the thread; a streaming answer is
  // followed unless the student scrolled up to read.
  const count = current.messages.length
  const shownCount = useRef(-1)
  useLayoutEffect(() => {
    const el = log.current
    if (!el) return
    const added = count !== shownCount.current
    shownCount.current = count
    const start = added ? el.querySelector<HTMLElement>('[data-latest-rich]') : null
    if (start) el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, start.offsetTop - SCROLL_MARGIN)
    else if (added || el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  })
  useEffect(() => {
    if (!chat?.open) return
    shownCount.current = -1
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat?.open])

  // The same reading as the study actions: a photo's caption, notes and what a model read on it included.
  const loadChunks = useCallback((ids: string[]): Promise<Chunk[]> => load({ sourceIds: ids, pasted: '' }), [load])

  // Saved one after another, in the order they happened: two quick changes (a card saved, then all the others)
  // never land the older one last.
  const saving = useRef<Promise<void>>(Promise.resolve())
  const persist = useCallback(
    (id: string, messages: ChatMessage[], forCourse: string | undefined) => {
      const updatedAt = Date.now()
      saving.current = saving.current
        .then(() => saveConversation(rt.store, forCourse, { id, messages, updatedAt }))
        .then(
          (list) => {
            if (forCourse === courseId) setChats(list)
          },
          (e: unknown) => console.warn('chat not saved', e),
        )
    },
    [rt, courseId],
  )

  // The course's passages, from which the structured answers quote what they cite.
  const hasRich = current.messages.some((m) => m.rich !== undefined && isCardRich(m.rich))
  useEffect(() => {
    if (!hasRich) return
    let alive = true
    const ids = courseId ? ws.sources.list({ courseId }).map((s) => s.id) : []
    loadChunks(ids).then(
      (loaded) => alive && setCourseChunks(loaded),
      (e: unknown) => console.warn('Course passages could not be read', e),
    )
    return () => {
      alive = false
    }
  }, [hasRich, courseId, ws, loadChunks])

  const ask = useCallback(
    async (history: ChatMessage[], { excerpt, intent }: { excerpt?: string; intent?: ChatIntent } = {}) => {
      if (ai.status !== 'ready') return
      abort.current?.abort()
      const ctl = new AbortController()
      abort.current = ctl
      const conv = current
      setCurrent({ ...conv, messages: history })
      setError(null)
      setLive({ text: '', chunks: [] })
      let text = ''
      let grounded: Chunk[] = []
      try {
        // A summary reads its source; within a course its sources; elsewhere, or without the screen, the library.
        const scoped = screenOn && courseId !== undefined
        const ids =
          intent === 'summarise' && context.sourceId
            ? [context.sourceId]
            : ws.sources.list(scoped ? { courseId } : undefined).map((s) => s.id)
        const chunks = await loadChunks(ids)
        // Written in the language of what is on screen: the card, else the open source, else the course's sources.
        const ctx = await ai.context(ctl.signal, course?.language, [
          cardText(context.card),
          passagesText(chunks.filter((c) => c.sourceId === context.sourceId)),
          passagesText(chunks),
        ])
        const about = {
          ...describeContext(ws, context),
          ...(excerpt ? { excerpt } : {}),
          ...(intent ? { intent } : {}),
        }
        const turn = buildTutorTurn(about, history, chunks, ctx.info, ctx.language)
        grounded = turn.chunks
        for await (const delta of tutorChat(ctx, turn)) {
          text += delta
          setLive({ text, chunks: grounded })
        }
      } catch (e) {
        if (!ctl.signal.aborted) {
          console.warn('chat answer failed', e)
          setError(t('chat.failed', { reason: describeFailure(e, t) }))
        }
      }
      if (abort.current === ctl) abort.current = null
      setLive(null)
      const kept = keepValidCitations(text, grounded).trim()
      const stopped = ctl.signal.aborted
      if (kept === '' && !stopped) return
      const messages: ChatMessage[] = [
        ...history,
        { role: 'assistant', text: stopped ? `${kept}${kept ? '\n\n' : ''}${t('chat.stopped')}` : kept },
      ]
      setCurrent((c) => (c.id === conv.id ? { ...c, messages } : c))
      persist(conv.id, messages, conv.courseId)
    },
    [ai, current, screenOn, courseId, ws, loadChunks, course, context, t, persist],
  )

  // « Explain the question » and « Why? »: a structured answer, written into the thread as it comes.
  const explain = useCallback(
    async (kind: CardRich['kind'], label: string, card: Card) => {
      if (ai.status !== 'ready') return
      abort.current?.abort()
      const ctl = new AbortController()
      abort.current = ctl
      const conv = current
      const history: ChatMessage[] = [...conv.messages, { role: 'user', text: label }]
      setCurrent({ ...conv, messages: history })
      setError(null)
      setNeedsSettings(false)
      retryRun.current = null
      const stream = kind === 'explainQuestion' ? questionStream : answerStream
      questionStream.reset()
      answerStream.reset()
      setLiveRich({ kind, card })
      let rich: RichResult | null = null
      try {
        const ids = courseId ? ws.sources.list({ courseId }).map((s) => s.id) : []
        const loaded = await loadChunks(ids)
        setCourseChunks(loaded)
        const cost = estimateCost(ai.info, loaded, EXPLAIN_OUTPUT_TOKENS)
        const content = [cardText(card), passagesText(loaded)]
        const ctx = { ...(await ai.context(ctl.signal, course?.language, content)), onPartial: stream.onPartial }
        const input = { chunks: loaded, courseTitle: course?.title }
        const faces = { front: card.front, back: card.back }
        rich =
          kind === 'explainQuestion'
            ? {
                kind,
                card: faces,
                cost,
                value: await explainQuestion(ctx, { card: faces, revealed: card.revealed, ...input }),
              }
            : { kind, card: faces, cost, value: await explainCard(ctx, { ...faces, ...input }) }
      } catch (e) {
        if (!ctl.signal.aborted) {
          console.warn('Explanation request failed', e)
          setError(t('chat.failed', { reason: describeFailure(e, t) }))
        }
      }
      if (abort.current === ctl) abort.current = null
      stream.reset()
      setLiveRich(null)
      if (rich === null || ctl.signal.aborted) return
      const messages: ChatMessage[] = [...history, { role: 'assistant', text: richText(rich), rich }]
      setCurrent((c) => (c.id === conv.id ? { ...c, messages } : c))
      persist(conv.id, messages, conv.courseId)
    },
    [ai, current, courseId, ws, loadChunks, course, t, persist, questionStream, answerStream],
  )

  // A study answer (cards, a quiz, a sheet, a grade, a photo, a rewrite): written into the thread as it comes, below
  // the student's turn, or in place of the answer it runs again.
  const runRich = useCallback(
    async (spec: StudyRunSpec) => {
      if (ai.status !== 'ready') return
      abort.current?.abort()
      const ctl = new AbortController()
      abort.current = ctl
      const conv = current
      const turn: ChatMessage | null = spec.label
        ? { role: 'user', text: spec.label, ...(spec.photoId ? { photoId: spec.photoId } : {}) }
        : null
      const history = turn ? [...conv.messages, turn] : conv.messages
      setCurrent({ ...conv, messages: history })
      setError(null)
      setNeedsSettings(false)
      retryRun.current = null
      for (const reset of streams.current.resets) reset()
      setLiveStudy({ kind: spec.kind, replacing: spec.replacing ?? null, ...(spec.card ? { card: spec.card } : {}) })
      let rich: RichResult | null = null
      try {
        rich = await spec.work({ signal: ctl.signal, onPartial: onPartialOf(streams.current.onPartials, spec.kind) })
      } catch (e) {
        if (!ctl.signal.aborted) {
          console.warn('Study request failed', e)
          // Tried again, it answers the same turn.
          retryRun.current = { ...spec, label: undefined }
          if (e instanceof VisionRequiredError) {
            setNeedsSettings(true)
            setError(
              ai.runsOffline ? t('photos.aiOnDeviceTextOnly') : t('photos.aiNeedVision', { model: ai.info.name }),
            )
          } else if (e instanceof PhotoUnavailableError) setError(t('photos.unavailable'))
          else setError(t('chat.failed', { reason: describeFailure(e, t) }))
        }
      }
      if (abort.current === ctl) abort.current = null
      for (const reset of streams.current.resets) reset()
      setLiveStudy(null)
      if (rich === null || ctl.signal.aborted) return
      const id = spec.replacing ?? rt.rng.id()
      const answer: ChatMessage = { role: 'assistant', text: richText(rich), rich, id }
      const messages = spec.replacing
        ? history.map((m) => (m.id === spec.replacing ? answer : m))
        : [...history, answer]
      setCurrent((c) => (c.id === conv.id ? { ...c, messages } : c))
      persist(conv.id, messages, conv.courseId)
      // A photo read is announced: the answer takes the focus.
      if (rich.kind === 'photo') setFocusId(id)
      spec.done?.(rich)
    },
    [ai, current, rt, persist, t],
  )

  const deps: StudyDeps | null = useMemo(
    () => (ai.status === 'ready' ? { ws, rt, ai, t, load } : null),
    [ai, ws, rt, t, load],
  )

  const study = useCallback(
    (kind: StudyKind, options: StudyOptions, o: { label?: string; replacing?: string }) => {
      if (!deps) return
      void runRich({ kind: STUDY_KIND[kind], ...o, work: (run) => runStudy(deps, kind, options, run) })
    },
    [deps, runRich],
  )

  const busy = live !== null || liveRich !== null || liveStudy !== null

  // A study sheet is written on its own screen: made in its place, then opened to be written by AI at once. Over the
  // page (below 1000px), the chat steps aside for it.
  const [, navigate] = useLocation()
  const writeSheetOn = useCallback(
    (place: StudyScope, title: string, sources: readonly string[] = []) => {
      const id = createFiche(ws, place, title, sources)
      if (!docked) onClose()
      navigate(`${to.fiche(id)}?${WRITE_QUERY}`)
    },
    [ws, docked, onClose, navigate],
  )
  const perform = useCallback(
    (action: ChatAction, on: ScreenContext, chosen?: Partial<StudyOptions>) => {
      if (action.kind === 'guided' && action.id === 'summarise' && on.sourceId) {
        const source = ws.sources.get(on.sourceId)
        if (!source) return
        const sectionId = ws.sections.tree().sectionOf(source)
        writeSheetOn(placeOf({ courseId: source.courseId, ...(sectionId ? { sectionId } : {}) }), source.title, [
          source.id,
        ])
        return
      }
      if (action.kind === 'guided') {
        void ask([...current.messages, { role: 'user', text: action.label }], { intent: action.intent })
        return
      }
      if (action.kind === 'study') {
        const start = startOptions(ws, action.id, on)
        if (!start) {
          setError(t('ai.needCourse'))
          return
        }
        if (action.id === 'understand') {
          writeSheetOn(placeOf({ ...start, ...chosen }), t('course.untitledSheet'))
          return
        }
        // A quiz runs on its own screen.
        if (action.id === 'quiz') {
          if (!docked) onClose()
          saveQuizRun(rt.store, newQuizRun({ ...start, ...chosen })).then(
            () => navigate(paths.quiz),
            (e: unknown) => console.warn('quiz not started', e),
          )
          return
        }
        study(action.id, { ...start, ...chosen }, { label: action.label })
        return
      }
      if (action.kind === 'answer') {
        // The answer is typed in the question box; nothing is asked before it is sent.
        if (on.card) setAnswering(on.card)
        setShowHistory(false)
        input.current?.focus()
        return
      }
      if (action.kind === 'improve') {
        const cardId = on.card?.id
        if (!deps || !cardId) return
        void runRich({ kind: 'improve', label: action.label, work: (run) => runImprove(deps, cardId, run) })
        return
      }
      if (action.kind === 'photo') {
        const photoId = on.photoId
        if (!deps || !photoId) return
        void runRich({
          kind: 'photo',
          label: action.label,
          photoId,
          work: (run) => runPhoto(deps, photoId, images, false, run),
        })
        return
      }
      if (action.kind === 'job') {
        const sourceId = on.sourceId
        if (!sourceId) return
        // The source's cards are proposed by the background queue; the thread follows it.
        void proposeFor(rt, sourceId)
        const conv = current
        const job: RichResult = { kind: 'job', sourceId }
        const messages: ChatMessage[] = [
          ...conv.messages,
          { role: 'user', text: action.label },
          { role: 'assistant', text: richText(job), rich: job, id: rt.rng.id() },
        ]
        setCurrent({ ...conv, messages })
        persist(conv.id, messages, conv.courseId)
        return
      }
      const card = on.card
      if (!card) return
      const kind = action.id === 'why' ? 'explainCard' : 'explainQuestion'
      // An explanation of this card already in the thread is shown again, not asked again.
      const given = current.messages.some(
        (m) => m.rich?.kind === kind && m.rich.card.front === card.front && m.rich.card.back === card.back,
      )
      if (!given) void explain(kind, action.label, card)
    },
    [ask, current, explain, ws, t, study, deps, runRich, images, rt, persist, writeSheetOn, docked, onClose, navigate],
  )

  // The answer typed in one's own words concerns the card it was asked for: another card, or its reveal, ends it.
  const cardKey = screen.card ? `${screen.card.front}\u0000${screen.card.back}` : ''
  const cardRevealed = screen.card?.revealed === true
  useEffect(() => {
    setAnswering((a) => (a && `${a.front}\u0000${a.back}` === cardKey && !cardRevealed ? a : null))
  }, [cardKey, cardRevealed])

  const grade = (answer: string) => {
    const card = answering
    if (!deps || !card) return
    setAnswering(null)
    const faces = { front: card.front, back: card.back }
    const language = screen.courseId ? ws.courses.get(screen.courseId)?.language : undefined
    void runRich({
      kind: 'grade',
      label: answer,
      card: faces,
      work: (run) => runGrade(deps, faces, answer, language, run),
      done: (rich) => {
        if (rich.kind === 'grade') chat?.grade({ card: faces, rating: rich.rating, feedback: rich.feedback })
      },
    })
  }

  // A grade picked in the chat goes to the card on screen; over the page (below 1000px) the chat then steps aside
  // so the next card shows.
  const rateCard = useCallback(
    (faces: { front: string; back: string }, rating: 1 | 2 | 3 | 4) => {
      chat?.rate({ card: faces, rating })
      if (!docked) onClose()
    },
    [chat, docked, onClose],
  )

  const update = useCallback(
    (id: string, rich: RichResult) => {
      const messages = current.messages.map((m) => (m.id === id ? { ...m, rich, text: richText(rich) } : m))
      setCurrent({ ...current, messages })
      persist(current.id, messages, current.courseId)
    },
    [current, persist],
  )

  const studyApi: StudyApi | null = useMemo(
    () =>
      deps && {
        ai: deps.ai,
        blocked: busy || !callable,
        load,
        update,
        rerun: (id, kind, options) => study(kind, options, { replacing: id }),
        rate: rateCard,
        start: (kind, options) =>
          kind === 'understand'
            ? writeSheetOn(placeOf(options), options.topic.trim() || t('course.untitledSheet'))
            : study(kind, options, { label: actionById(t, {}, kind)?.label ?? '' }),
        explainPhoto: (photoId) => {
          void runRich({
            kind: 'photo',
            label: t('chat.actionExplainPhoto'),
            photoId,
            work: (run) => runPhoto(deps, photoId, images, true, run),
          })
        },
        photoCards: (courseId, photoIds, count) => {
          void runRich({
            kind: 'cards',
            label: t('photos.aiCards'),
            ...(photoIds[0] ? { photoId: photoIds[0] } : {}),
            work: (run) => runPhotoCards(deps, courseId, photoIds, count, images, run),
          })
        },
        checkExplanation: (options, explanation, onPartial) =>
          checkExplanation(deps, options, explanation, { signal: new AbortController().signal, onPartial }),
      },
    [deps, busy, callable, load, update, study, t, runRich, images, rateCard, writeSheetOn],
  )

  // Run from the screen (« Explain the question » in review): as soon as the chat can, with the screen's context.
  // Once carried out it is settled in the hub, so a panel mounted again later (the model set up again) never runs
  // it a second time.
  const running = chat?.running
  const settle = chat?.settle
  const ran = useRef<number | null>(null)
  useEffect(() => {
    if (!running || ran.current === running.seq) return
    // Waits for the course's conversation when the screen just moved to another course, and for the course (and
    // section) asked for when the action was run with one.
    if (ai.status !== 'ready' || !callable || busy || current.courseId !== courseId) return
    const scope = running.scope
    if (scope && (scope.courseId !== screen.courseId || (scope.sectionId ?? '') !== (screen.sectionId ?? ''))) return
    ran.current = running.seq
    settle?.(running.seq)
    setShowHistory(false)
    setDetached(null)
    const action = actionById(t, screen, running.id)
    if (action) perform(action, screen, running.options)
    else console.warn(`Chat action "${running.id}" has nothing to act on here`)
  }, [running, settle, ai.status, callable, busy, current.courseId, courseId, t, screen, perform])

  // Asked from the screen (a term selected there): sent as soon as the chat can answer, in the chat on screen.
  const asked = chat?.asked
  const handled = useRef<number | null>(null)
  useEffect(() => {
    if (!asked || handled.current === asked.seq) return
    if (ai.status !== 'ready' || !callable || busy) return
    handled.current = asked.seq
    settle?.(asked.seq)
    setShowHistory(false)
    void ask([...current.messages, { role: 'user', text: asked.text }], asked.excerpt ? { excerpt: asked.excerpt } : {})
  }, [asked, settle, ai.status, callable, busy, current.messages, ask])

  const send = (text: string) => {
    const q = text.trim()
    if (q === '' || busy || !callable) return
    setDraft('')
    if (input.current) input.current.style.height = ''
    if (answering) grade(q)
    else void ask([...current.messages, { role: 'user', text: q }])
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    send(draft)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send(draft)
    }
  }

  // Stopped, the button goes: the focus stays in the panel, on the question box, never back to the page's top.
  const stop = () => {
    abort.current?.abort()
    input.current?.focus()
  }

  const startNew = () => {
    abort.current?.abort()
    setError(null)
    setNeedsSettings(false)
    setAnswering(null)
    setShowHistory(false)
    setCurrent({ id: rt.rng.id(), messages: [], ...(courseId ? { courseId } : {}) })
    input.current?.focus()
  }

  const retry = () => {
    const again = retryRun.current
    if (again) {
      void runRich(again)
      return
    }
    const history = current.messages
    if (history.at(-1)?.role === 'user') void ask(history)
  }

  // Below 1000px the sheet covers the page: following a citation or a link closes it.
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = body.current
    if (!el || docked) return
    const onClick = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('a')) onClose()
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  })

  const chip = chipLabel(t, ws, screen)
  const actions = actionsFor(t, context)
  // The screen's actions sit right above the composer, within a thumb's reach: one line that scrolls sideways
  // on phones (faded where more is hidden), wrapped on wider panels. Hidden while the keyboard is up.
  const actionRow = actions.length > 0 && (
    <ul
      ref={actionList}
      className={styles.actionRow}
      aria-label={t('chat.actions')}
      data-more={actionsMore || undefined}
      onScroll={measureActions}
    >
      {actions.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            className={styles.suggestion}
            disabled={!callable || busy}
            onClick={() => perform(a, context)}
          >
            {a.label}
          </button>
        </li>
      ))}
    </ul>
  )
  const card = context.card
  const costOf = (rich: RichResult) => {
    const cost = 'cost' in rich ? rich.cost : undefined
    return cost === undefined || ai.status !== 'ready'
      ? null
      : `${t('ai.cost', { amount: formatUsd(locale, cost) })} · ${ai.info.name}`
  }
  const liveView = (l: LiveStudy) => {
    switch (l.kind) {
      case 'cards':
        return cardsStream.partial ? (
          <PartialCards partial={cardsStream.partial} />
        ) : (
          <Writing text={t('chat.writing')} />
        )
      case 'quiz':
        return <PartialQuiz partial={quizStream.partial} />
      case 'sheet':
        return sheetStream.partial ? (
          <PartialSheet partial={sheetStream.partial} />
        ) : (
          <Writing text={t('chat.writing')} />
        )
      case 'grade':
        return <PartialGrade partial={gradeStream.partial} card={l.card ?? { front: '', back: '' }} />
      case 'photo':
        return <PartialPhoto partial={photoStream.partial} />
      case 'improve':
        return <PartialImprove partial={improveStream.partial} hideBack={screen.card?.revealed === false} />
      default:
        return <Writing text={t('chat.writing')} />
    }
  }
  const liveAnswer = liveStudy && (
    <div className={styles.answer}>
      <span className="sr-only">{t('chat.tutor')}: </span>
      {liveView(liveStudy)}
    </div>
  )

  const contextChip = screenOn ? (
    <span className={styles.chip}>
      <span className={styles.chipText}>{t('chat.about', { what: chip })}</span>
      {chip !== t('chat.aboutLibrary') && (
        <button
          type="button"
          className={styles.chipRemove}
          aria-label={t('chat.removeContext')}
          title={t('chat.removeContext')}
          onClick={() => setDetached(screenKey)}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </span>
  ) : (
    <span className={styles.chip}>
      <span className={styles.chipText}>{t('chat.wholeLibrary')}</span>
      <button type="button" className={styles.chipAction} onClick={() => setDetached(null)}>
        {t('chat.useScreen')}
      </button>
    </span>
  )

  const tools = (
    <>
      <IconButton
        icon={History}
        label={t('chat.history')}
        aria-pressed={showHistory}
        onClick={() => setShowHistory((s) => !s)}
      />
      <IconButton icon={SquarePen} label={t('chat.newChat')} onClick={startNew} />
    </>
  )
  // Docked, the panel carries its own title. Full screen or as a side panel, one compact row: close, the context
  // (or the list's name), then the tools.
  const toolbar = docked ? (
    <div className={styles.toolbar}>
      <h2 className={styles.title}>{t('chat.title')}</h2>
      <div className={styles.tools}>
        {tools}
        <IconButton icon={X} label={t('chat.closePanel')} onClick={onClose} />
      </div>
    </div>
  ) : (
    <div className={cx(styles.toolbar, styles.compact)}>
      <IconButton icon={X} label={t('chat.closePanel')} onClick={onClose} />
      <div className={styles.context}>
        {showHistory ? (
          <span className={styles.heading}>{t('chat.history')}</span>
        ) : (
          ai.status === 'ready' && contextChip
        )}
      </div>
      <div className={styles.tools}>{tools}</div>
    </div>
  )

  if (ai.status === 'loading') return <div className={styles.body}>{toolbar}</div>
  // The panel only mounts once a model is ready (ChatSlot); this covers the moment a model goes away while it is open.
  if (ai.status === 'missing') {
    return (
      <div className={styles.body}>
        {toolbar}
        <div className={styles.setup}>
          <p className={styles.setupTitle}>{t('chat.setupTitle')}</p>
          <p className={styles.muted}>{t('chat.setupBody')}</p>
          <Link
            href={paths.settingsAi}
            className={buttonClass({ variant: 'primary' })}
            onClick={docked ? undefined : onClose}
          >
            {t('chat.setup')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div ref={body} className={cx(styles.body, !docked && styles.covering)}>
      {toolbar}
      {showHistory ? (
        <HistoryList
          chats={chats}
          currentId={current.id}
          onOpen={(c) => {
            abort.current?.abort()
            setCurrent({ id: c.id, messages: c.messages, ...(courseId ? { courseId } : {}) })
            setShowHistory(false)
          }}
          onDelete={(c) => {
            deleteConversation(rt.store, courseId, c.id).then(setChats, (e: unknown) => console.warn(e))
            // The list stays open: the chat on screen becomes a new one.
            if (c.id === current.id) setCurrent({ id: rt.rng.id(), messages: [], ...(courseId ? { courseId } : {}) })
          }}
          onClear={() => {
            clearConversations(rt.store, courseId).then(
              () => setChats([]),
              (e: unknown) => console.warn(e),
            )
            startNew()
          }}
        />
      ) : (
        <>
          {docked && <div className={styles.context}>{contextChip}</div>}
          <div ref={log} className={styles.log} role="log" aria-label={t('chat.title')} aria-busy={busy || undefined}>
            {current.messages.length === 0 && !busy && !answering && (
              <div className={styles.intro}>
                <p className={styles.muted}>{t('chat.intro')}</p>
              </div>
            )}
            {keyed(
              current.messages.map((m, at) => ({ m, before: current.messages[at - 1] })),
              // A structured answer keeps its id while it changes (a card saved, a quiz answered).
              ({ m }) => m.id ?? `${m.role}:${m.text}`,
            ).map(({ item: { m, before }, key }) => {
              const rich = m.rich
              if (!rich) {
                return (
                  <Message
                    key={key}
                    message={m}
                    question={before?.role === 'user' ? before.text : undefined}
                    card={card}
                    courseId={courseId}
                    sectionId={context.sectionId}
                  />
                )
              }
              // Run again, the answer gives way to the new one as it is written.
              if (liveStudy && m.id !== undefined && liveStudy.replacing === m.id) {
                return <div key={key}>{liveAnswer}</div>
              }
              const cost = costOf(rich)
              return (
                <div
                  key={key}
                  ref={focusId !== null && m.id === focusId ? focusOnce(setFocusId) : undefined}
                  tabIndex={focusId !== null && m.id === focusId ? -1 : undefined}
                  className={styles.answer}
                  data-latest-rich={m === current.messages.at(-1) || undefined}
                >
                  <span className="sr-only">{t('chat.tutor')}: </span>
                  {isCardRich(rich) ? (
                    <RichAnswer
                      rich={rich}
                      revealed={revealedFor(rich.card, screen.card)}
                      chunks={courseChunks}
                      courseId={current.courseId}
                      footer={cost && <RichNote>{cost}</RichNote>}
                    />
                  ) : (
                    studyApi && (
                      <StudyProvider value={studyApi}>
                        <StudyAnswer
                          id={m.id ?? key}
                          rich={rich}
                          revealed={studyRevealed(rich, screen.card)}
                          onScreen={onScreen(rich, screen.card)}
                        />
                      </StudyProvider>
                    )
                  )}
                </div>
              )
            })}
            {liveStudy && liveStudy.replacing === null && liveAnswer}
            {liveRich && (
              <div className={styles.answer}>
                <span className="sr-only">{t('chat.tutor')}: </span>
                {questionStream.partial || answerStream.partial ? (
                  <PartialRich
                    kind={liveRich.kind}
                    question={questionStream.partial}
                    answer={answerStream.partial}
                    card={liveRich.card}
                    revealed={revealedFor(liveRich.card, screen.card)}
                  />
                ) : (
                  <p className={styles.muted} role="status">
                    {t('chat.writing')}
                  </p>
                )}
              </div>
            )}
            {live && (
              <Answer segments={parseCitations(live.text, live.chunks).segments} card={card} streaming>
                {live.text === '' && (
                  <p className={styles.muted} role="status">
                    {t('chat.writing')}
                  </p>
                )}
              </Answer>
            )}
            {error && (
              <div className={styles.error} role="alert">
                <p>{error}</p>
                {needsSettings ? (
                  <Link href={paths.settingsAi} className={buttonClass({ variant: 'plain' })}>
                    {t('ai.openSettings')}
                  </Link>
                ) : (
                  <Button variant="plain" onClick={retry}>
                    {t('chat.retry')}
                  </Button>
                )}
              </div>
            )}
          </div>
          {actionRow}
          {!callable && <p className={styles.note}>{t('chat.offline')}</p>}
          {answering && !busy && (
            // The question being answered stays in sight above the answer box, the keyboard up or not.
            <section className={styles.answering} aria-labelledby={`${current.id}-answering`}>
              <p id={`${current.id}-answering`} className={styles.answeringLabel}>
                {t('chat.answeringTitle')}
              </p>
              <div className={styles.answeringQuestion}>
                <Sanitized markdown={answering.front} />
              </div>
              <p className={styles.note}>{t('chat.answerPrompt')}</p>
            </section>
          )}
          <form className={styles.composer} onSubmit={submit}>
            <label className="sr-only" htmlFor={`${current.id}-q`}>
              {answering ? t('review.yourAnswer') : t('chat.inputLabel')}
            </label>
            <textarea
              id={`${current.id}-q`}
              ref={input}
              className={styles.input}
              rows={1}
              value={draft}
              placeholder={answering ? t('review.ownWordsPlaceholder') : t('chat.placeholder')}
              disabled={!callable}
              enterKeyHint="send"
              onChange={(e) => {
                setDraft(e.target.value)
                grow(e.currentTarget)
              }}
              onKeyDown={onKeyDown}
            />
            {busy ? (
              <Button variant="secondary" onClick={stop}>
                {t('chat.stop')}
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!callable || draft.trim() === ''}>
                {answering ? t('review.check') : t('chat.send')}
              </Button>
            )}
          </form>
        </>
      )}
    </div>
  )
}

/** Whether a study answer may show the card's answer: a grade or a rewrite of the card on screen waits for its reveal. */
function studyRevealed(rich: RichResult, card: ScreenContext['card']): boolean {
  if (rich.kind === 'grade') return revealedFor(rich.card, card)
  if (rich.kind === 'improve') return !(card && !card.revealed && card.id === rich.cardId)
  return true
}

/** Whether a grade is about the card on screen, so it can still be given to it from here. */
function onScreen(rich: RichResult, card: ScreenContext['card']): boolean {
  return rich.kind === 'grade' && card !== undefined && card.front === rich.card.front && card.back === rich.card.back
}

function Writing({ text }: { text: string }) {
  return (
    <p className={styles.muted} role="status">
      {text}
    </p>
  )
}

/** Focuses an answer as it arrives (VoiceOver reads it from there), once. */
const focusOnce = (done: (id: null) => void) => (el: HTMLDivElement | null) => {
  if (!el) return
  el.focus({ preventScroll: true })
  done(null)
}

/** The question box grows with what is typed, up to its maximum height, then scrolls. */
function grow(el: HTMLTextAreaElement): void {
  el.style.height = ''
  el.style.height = `${el.scrollHeight}px`
}

function chipLabel(t: ReturnType<typeof useT>, ws: ModelWorkspace, c: ScreenContext): string {
  if (c.card) return t('chat.aboutCard')
  if (c.question) return t('chat.aboutQuestion')
  if (c.photoId) return t('chat.aboutPhoto')
  const source = c.sourceId ? ws.sources.get(c.sourceId) : undefined
  if (source) return source.title
  const section = c.sectionId ? ws.sections.get(c.sectionId) : undefined
  if (section) return section.name
  const course = c.courseId ? ws.courses.get(c.courseId) : undefined
  if (course) return course.title
  return t('chat.aboutLibrary')
}

/** The answer's text, citations removed, for a card or the clipboard. */
const plainText = (segments: readonly ChatSegment[]) =>
  segments
    .flatMap((s) => (s.kind === 'text' ? [s.text] : []))
    .join('')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim()

function Message({
  message,
  question,
  card,
  courseId,
  sectionId,
}: {
  message: ChatMessage
  question: string | undefined
  card: ScreenContext['card']
  courseId: string | undefined
  sectionId: string | undefined
}) {
  const t = useT()
  if (message.role === 'user') {
    return (
      <>
        {message.photoId && <AttachedPhoto photoId={message.photoId} />}
        <div className={styles.user}>
          <span className="sr-only">{t('chat.you')}: </span>
          {message.text}
        </div>
      </>
    )
  }
  const segments = parseCitations(message.text).segments
  return (
    <Answer segments={segments} card={card}>
      <AnswerActions segments={segments} question={question} courseId={courseId} sectionId={sectionId} card={card} />
    </Answer>
  )
}

/** A cited passage's address: the source, at its page, slide or section when there is one. */
const citeHref = (ref: SourceRef) =>
  ref.page === undefined ? to.source(ref.sourceId) : `${to.source(ref.sourceId)}?page=${ref.page}`

/**
 * The answer as Markdown, its citations numbered in order of first use (`[1]` links to the passage, the sources
 * are listed by name below). A streamed answer ends with a cursor.
 */
function answerMarkdown(segments: readonly ChatSegment[], streaming: boolean): { markdown: string; refs: SourceRef[] } {
  const order = new Map<string, number>()
  const refs: SourceRef[] = []
  let markdown = ''
  for (const s of segments) {
    if (s.kind === 'text') {
      markdown += s.text
      continue
    }
    const key = `${s.ref.sourceId}\u0000${s.ref.page ?? ''}`
    let n = order.get(key)
    if (n === undefined) {
      refs.push(s.ref)
      n = refs.length
      order.set(key, n)
    }
    markdown += ` [${n}](#${citeHref(s.ref)})`
  }
  return { markdown: streaming && markdown !== '' ? `${markdown} ▍` : markdown, refs }
}

function Answer({
  segments,
  card,
  streaming = false,
  children,
}: {
  segments: ChatSegment[]
  card: ScreenContext['card']
  streaming?: boolean
  children?: ReactNode
}) {
  const t = useT()
  const guarded = guardReply(segments, card)
  const { markdown, refs } = answerMarkdown(guarded.segments, streaming)
  return (
    <div className={styles.answer}>
      <span className="sr-only">{t('chat.tutor')}: </span>
      {markdown !== '' && (
        <div className={styles.answerText}>
          <Sanitized markdown={markdown} />
        </div>
      )}
      {refs.length > 0 && (
        <ol className={styles.sources} aria-label={t('chat.sources')}>
          {refs.map((ref, i) => (
            <li key={`${ref.sourceId}/${ref.page ?? ''}`} className={styles.source}>
              <span className={styles.sourceNumber} aria-hidden="true">
                {i + 1}
              </span>
              <Citation sourceRef={ref} />
            </li>
          ))}
        </ol>
      )}
      {guarded.leaked && <p className={styles.note}>{t('chat.hidden')}</p>}
      {children}
    </div>
  )
}

function AnswerActions({
  segments,
  question,
  courseId,
  sectionId,
  card,
}: {
  segments: ChatSegment[]
  question: string | undefined
  courseId: string | undefined
  sectionId: string | undefined
  card: ScreenContext['card']
}) {
  const t = useT()
  const ws = useWorkspace()
  const status = useId()
  const [made, setMade] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => plainText(segments), [segments])
  // Before the reveal an answer is not copied or turned into a card: that would show it.
  if (text === '' || (card && !card.revealed)) return null

  // Suggested, never added on its own: it waits in « Suggested cards » with the others.
  const makeCard = () => {
    if (!courseId) return
    const [id] = ws.drafts.propose([
      {
        courseId,
        ...(sectionId ? { sectionId } : {}),
        unit: 0,
        kind: 'basic',
        type: 'qa',
        front: question?.trim() || text.split('\n')[0] || text,
        back: text,
      },
    ])
    setMade(id ?? null)
  }

  const copy = () => {
    navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      (e: unknown) => console.warn('copy failed', e),
    )
  }

  return (
    <div className={styles.actions}>
      {courseId && (
        <Button
          variant="plain"
          icon={<Plus size={16} strokeWidth={1.75} aria-hidden />}
          disabled={made !== null}
          aria-describedby={made ? status : undefined}
          onClick={makeCard}
        >
          {t('chat.makeCard')}
        </Button>
      )}
      <Button
        variant="plain"
        icon={
          copied ? (
            <Check size={16} strokeWidth={1.75} aria-hidden />
          ) : (
            <Copy size={16} strokeWidth={1.75} aria-hidden />
          )
        }
        onClick={copy}
      >
        {copied ? t('chat.copied') : t('chat.copy')}
      </Button>
      {made && courseId && (
        <p id={status} className={styles.made} role="status">
          {t('chat.cardSuggested')} <Link href={paths.inbox}>{t('chat.openSuggested')}</Link>
        </p>
      )}
    </div>
  )
}

function HistoryList({
  chats,
  currentId,
  onOpen,
  onDelete,
  onClear,
}: {
  chats: readonly Conversation[]
  currentId: string
  onOpen: (c: Conversation) => void
  onDelete: (c: Conversation) => void
  onClear: () => void
}) {
  const t = useT()
  if (chats.length === 0) return <p className={cx(styles.muted, styles.pad)}>{t('chat.historyEmpty')}</p>
  return (
    <div className={styles.history}>
      <ul className={styles.historyList}>
        {chats.map((c) => {
          const title = c.title || t('chat.untitled')
          return (
            <li key={c.id} className={styles.historyRow}>
              <button
                type="button"
                className={styles.historyOpen}
                aria-current={c.id === currentId || undefined}
                aria-label={t('chat.openChat', { title })}
                onClick={() => onOpen(c)}
              >
                {title}
              </button>
              <IconButton icon={Trash2} label={t('chat.deleteChat', { title })} onClick={() => onDelete(c)} />
            </li>
          )
        })}
      </ul>
      <Button variant="plain" onClick={onClear}>
        {t('chat.clearAll')}
      </Button>
    </div>
  )
}
