import { FolderInput, History, Share, Trash2, Wand2 } from 'lucide-react'
import { type FocusEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'wouter'
import * as Y from 'yjs'
import { lazyChunk, nothing } from '../../app/lazyChunk.tsx'
import { backHome, goBack, leaveTo } from '../../app/nav.ts'
import { to } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { PATH_SEPARATOR } from '../../core/model/sections'
import { useT } from '../../i18n/react.tsx'
import { beforeUpdate } from '../../pwa/index.ts'
import { useAiReady } from '../../ui/ai/ready.ts'
import { useChatContext } from '../../ui/chat/context.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Keycap } from '../../ui/components/Keycap.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { cx } from '../../ui/cx.ts'
import { MarkdownEditor } from '../../ui/editor/MarkdownEditor.tsx'
import { MoveSheet, moveItemTo } from '../../ui/MoveSheet.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import type { CardNotice } from '../Course/index.tsx'
import { applyForward } from '../History/replay.ts'
import NotFound from '../NotFound/index.tsx'
import CardPhotos from '../Photos/CardPhotos.tsx'
import { useFileLoader } from '../Photos/files.ts'
import type { Rewritten } from '../Review/ImproveSheet.tsx'
import { replaceFaces } from '../Review/replaceFaces.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './CardEditor.module.css'
import { ClozePreview } from './ClozePreview.tsx'
import {
  type CardFields,
  dropDraft,
  EMPTY,
  keepDraft,
  newCardCourse,
  newCardSection,
  readDraft,
  sameFields,
} from './draft.ts'
import { saveExisting } from './merge.ts'

/** « Improve » a card with AI, loaded when opened (it brings the AI code). */
const ImproveSheet = lazyChunk<Parameters<typeof import('../Review/ImproveSheet.tsx').ImproveSheet>[0]>(
  'improve',
  () => import('../Review/ImproveSheet.tsx').then((m) => ({ default: m.ImproveSheet })),
  nothing,
)

type Kind = CardFields['kind']

/** A scratch document, never the workspace's: the draft lives here until Save. */
interface Draft {
  doc: Y.Doc
  front: Y.Text
  back: Y.Text
}

function scratch(f: CardFields): Draft {
  const doc = new Y.Doc()
  const front = doc.getText('front')
  const back = doc.getText('back')
  front.insert(0, f.front)
  back.insert(0, f.back)
  return { doc, front, back }
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(any-pointer: coarse)').matches

/**
 * A face taken low on a touch screen comes up to its top: the keyboard is about to cover the bottom of the screen,
 * and an iPad window does not always say so (nothing would then bring the caret above it).
 */
function raise(e: FocusEvent<HTMLElement>) {
  if (!TOUCH || !(e.target instanceof HTMLElement) || !e.target.isContentEditable) return
  const side = e.currentTarget
  const visible = window.visualViewport?.height ?? window.innerHeight
  if (side.getBoundingClientRect().top > visible / 2) side.scrollIntoView({ block: 'start' })
}

/** The next new card after « Save and add another »: written in the same place, of the same kind. */
interface Next {
  /** The new-card route it follows on: another screen (or another place) starts afresh. */
  id: string
  round: number
  kind: Kind
}

/**
 * « Save and add another » keeps the route (a new card's id is its place) and starts the editor afresh, so the next
 * card begins as one opened from the course does: empty, no draft, the cursor in the front.
 */
export default function CardEditor() {
  const { id = '' } = useParams<{ id: string }>()
  const [next, setNext] = useState<Next | null>(null)
  const following = next?.id === id ? next : null
  const onNext = useCallback(
    (kind: Kind) => setNext((n) => ({ id, round: (n?.id === id ? n.round : 0) + 1, kind })),
    [id],
  )
  return <Editor key={following?.round ?? 0} id={id} next={following} onNext={onNext} />
}

function Editor({ id, next, onNext }: { id: string; next: Next | null; onNext: (kind: Kind) => void }) {
  const t = useT()
  const rt = useRuntime()
  const ws = rt.ws
  const aiReady = useAiReady()
  const [improving, setImproving] = useState(false)
  const [rewritten, setRewritten] = useState<Rewritten | null>(null)
  const newCourse = newCardCourse(id)
  const newSection = newCardSection(id)
  const card = useWorkspaceData(['cards', 'courses', 'sections', 'sources', { id }], (w) => {
    if (newCourse !== null) {
      const course = w.courses.get(newCourse)
      if (!course || course.deletedAt !== undefined) return null
      // A card started inside a section lands there; if that section went to the trash (or is gone) meanwhile,
      // in its nearest live ancestor, or the course root, and the editor says where.
      const tree = w.sections.tree()
      const chain = newSection === null ? [] : tree.chain(newSection).filter((s) => s.courseId === newCourse)
      const sectionId = chain.filter((s) => !tree.hidden(s.id)).at(-1)?.id ?? null
      const relocated =
        newSection !== null && sectionId !== newSection
          ? [course.title, ...(sectionId === null ? [] : tree.chain(sectionId).map((s) => s.name))].join(PATH_SEPARATOR)
          : null
      return { courseId: newCourse, sectionId, saved: null, relocated, from: null }
    }
    const c = w.cards.get(id)
    if (!c || c.deletedAt !== undefined) return null
    const saved: CardFields = {
      kind: c.kind,
      front: w.text({ id: c.id, field: 'front' }).toString(),
      back: w.text({ id: c.id, field: 'back' }).toString(),
    }
    // Where it was written from: the source, and the slide or page it cites (a section label needs its draft).
    const source = c.sourceId === undefined ? undefined : w.sources.get(c.sourceId)
    const from =
      source === undefined || source.deletedAt !== undefined
        ? null
        : {
            id: source.id,
            title: source.title,
            unit:
              c.unit === undefined || c.unit < 1
                ? null
                : source.support === 'deck'
                  ? { n: c.unit, kind: 'slide' as const }
                  : source.kind === 'pdf' && source.support !== undefined
                    ? { n: c.unit, kind: 'page' as const }
                    : null,
          }
    return { courseId: c.courseId, sectionId: w.sections.tree().sectionOf(c), saved, relocated: null, from }
  })
  const saved = card?.saved ?? EMPTY
  const savedRef = useRef(saved)
  savedRef.current = saved
  // The card being written: its answer is in plain view, so the chat may discuss it.
  useChatContext(
    card === null
      ? {}
      : {
          courseId: card.courseId,
          ...(card.sectionId ? { sectionId: card.sectionId } : {}),
          ...(saved.front.trim() ? { cardId: id, card: { front: saved.front, back: saved.back, revealed: true } } : {}),
        },
  )

  const [draft, setDraft] = useState<Draft | null>(null)
  /** The card values the draft was seeded from: Save writes only what the draft changed since. */
  const [base, setBase] = useState<CardFields>(EMPTY)
  /** Save could not merge a field changed on another device: the draft is kept instead. */
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  /** A new card, once created by Save: a second Save cannot create it again. */
  const createdRef = useRef<string | null>(null)
  const [kind, setKind] = useState<Kind>('basic')
  const [fields, setFields] = useState<CardFields>(EMPTY)
  const [restored, setRestored] = useState(false)
  const [asking, setAsking] = useState(false)
  const [moving, setMoving] = useState(false)
  const [movedTo, setMovedTo] = useState<string | null>(null)
  const [shareStatus, setShareStatus] = useState<string | null>(null)
  const loadFile = useFileLoader()
  const pageRef = useRef<HTMLDivElement>(null)
  const exists = card !== null
  /** The card before this one was just added (« Save and add another »): said once the editor is in place, until
   *  this one is being written. */
  const [added, setAdded] = useState(false)
  useEffect(() => setAdded(next !== null), [next])
  /** What the editor starts from when no draft is kept: the saved card, or the next one's kind. */
  const nextKind = next?.kind
  const fresh = useCallback(
    (): CardFields => (nextKind === undefined ? savedRef.current : { ...EMPTY, kind: nextKind }),
    [nextKind],
  )

  // Seed the draft once per card: an unsaved draft kept on this device wins over the saved card.
  useEffect(() => {
    if (!exists) return
    let live = true
    readDraft(rt.store, id).then(
      (kept) => {
        if (!live) return
        const b = kept?.base ?? fresh()
        const seed = kept?.fields ?? fresh()
        setRestored(kept !== null && !sameFields(kept.fields, b))
        setBase(b)
        setKind(seed.kind)
        setFields(seed)
        setDraft(scratch(seed))
      },
      (e: unknown) => {
        noteError('card.draft', e)
        if (live) {
          const seed = fresh()
          setBase(seed)
          setKind(seed.kind)
          setFields(seed)
          setDraft(scratch(seed))
        }
      },
    )
    return () => {
      live = false
    }
  }, [rt, id, exists, fresh])

  // Every keystroke updates the draft (and its copy on this device), never the card.
  useEffect(() => {
    if (!draft) return
    const update = () => {
      setFields((f) => ({ ...f, front: draft.front.toString(), back: draft.back.toString() }))
    }
    draft.doc.on('update', update)
    return () => draft.doc.off('update', update)
  }, [draft])
  const current = useMemo<CardFields>(() => ({ ...fields, kind }), [fields, kind])
  const dirty =
    draft !== null && (newCourse !== null ? current.front !== '' || current.back !== '' : !sameFields(current, base))
  useEffect(() => {
    if (dirty) setAdded(false)
  }, [dirty])

  // A field left untouched here follows edits made elsewhere, so the draft never holds a stale copy.
  const { front: savedFront, back: savedBack, kind: savedKind } = saved
  useEffect(() => {
    if (!draft || newCourse !== null) return
    let next = base
    for (const [field, value] of [
      ['front', savedFront],
      ['back', savedBack],
    ] as const) {
      if (value !== base[field] && draft[field].toString() === base[field]) {
        applyForward(draft[field], value)
        next = { ...next, [field]: value }
      }
    }
    if (savedKind !== base.kind && kind === base.kind) {
      setKind(savedKind)
      next = { ...next, kind: savedKind }
    }
    if (next !== base) setBase(next)
  }, [draft, newCourse, base, kind, savedFront, savedBack, savedKind])

  // While Save (or Discard) is writing, the draft is on its way out: a copy still waiting would land after it was
  // dropped and come back as a draft of a card that already exists, to be saved a second time.
  useEffect(() => {
    if (!draft || saving) return
    const timer = setTimeout(() => {
      keepDraft(rt.store, id, current, newCourse !== null ? { ...EMPTY, kind: current.kind } : base).catch(
        (e: unknown) => noteError('card.draft', e),
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [rt, id, draft, saving, current, newCourse, base])

  // An update reloads the page: the copy above may still be waiting, so the draft is kept first.
  useEffect(() => {
    if (!draft || !dirty || saving) return
    return beforeUpdate(() =>
      keepDraft(rt.store, id, current, newCourse !== null ? { ...EMPTY, kind: current.kind } : base),
    )
  }, [rt, id, draft, dirty, saving, current, newCourse, base])

  // Back to the screen the card was opened from (as the header's Back), else its place. Opened from a course place
  // that is not its own any more (moved, or that place went to the trash), it lands where the card actually is.
  const leave = useCallback(
    (notice?: CardNotice) => {
      const home = to.place(card?.courseId ?? '', card?.sectionId)
      goBack(home, { ...(notice ? { state: notice } : {}), ...backHome(home) })
    },
    [card?.courseId, card?.sectionId],
  )

  /** Creates the new card from the draft in one batch, once. */
  const create = useCallback(
    (f: CardFields, courseId: string): string => {
      const sectionId = card?.sectionId ?? undefined
      return ws.batch(() => {
        const cid = ws.cards.create(sectionId ? { courseId, sectionId, kind: f.kind } : { courseId, kind: f.kind })
        applyForward(ws.text({ id: cid, field: 'front' }), f.front)
        applyForward(ws.text({ id: cid, field: 'back' }), f.back)
        return cid
      })
    },
    [ws, card?.sectionId],
  )

  /** Holds Save (buttons, shortcuts, key repeat) until the write and what follows it are done. */
  const hold = useCallback((): boolean => {
    if (savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    return true
  }, [])
  const release = useCallback(() => {
    savingRef.current = false
    setSaving(false)
  }, [])

  /** Saves the draft; `andNext` (a new card only) then opens the next new card in the same place instead of leaving. */
  const save = useCallback(
    (andNext = false) => {
      if (!dirty || !card || !draft || !hold()) return
      if (newCourse !== null) {
        if (createdRef.current === null) createdRef.current = create(current, newCourse)
      } else {
        const conflicts = saveExisting(ws, id, base, current)
        if (conflicts.length > 0) {
          // Merged fields are saved; the others keep the remote text, and the user's version stays as the draft.
          const now: CardFields = {
            kind: ws.cards.get(id)?.kind ?? current.kind,
            front: ws.text({ id, field: 'front' }).toString(),
            back: ws.text({ id, field: 'back' }).toString(),
          }
          for (const field of ['front', 'back'] as const) {
            if (!conflicts.includes(field)) applyForward(draft[field], now[field])
          }
          setBase(now)
          setConflict(true)
          rt.seal()
            .catch((e: unknown) => noteError('card.save', e))
            .finally(release)
          return
        }
      }
      // Saved means on disk before leaving, not at the next idle seal. A new card's place offers the next one; the
      // next card itself starts once its draft is gone, so it starts empty.
      void Promise.all([rt.seal(), dropDraft(rt.store, id)])
        .catch((e: unknown) => noteError('card.save', e))
        .finally(() => {
          if (newCourse === null) leave({ cardSaved: true })
          else if (andNext) onNext(current.kind)
          else leave({ cardSaved: true, cardAdded: true })
        })
    },
    [dirty, card, draft, hold, release, newCourse, create, current, ws, id, base, rt, leave, onNext],
  )

  // Back with unsaved changes asks once instead of leaving (the header's Back stays a plain link).
  useEffect(() => {
    const page = pageRef.current
    if (!page) return
    const guard = (e: Event) => {
      if (dirty && e.target instanceof Element && e.target.closest('header a')) {
        e.preventDefault()
        e.stopPropagation()
        setAsking(true)
      }
    }
    page.addEventListener('click', guard, true)
    return () => page.removeEventListener('click', guard, true)
  })

  // ⌘S / Ctrl+S and ⌘Enter save from anywhere in the editor; ⇧⌘Enter / Ctrl+Shift+Enter saves a new card and opens
  // the next one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 's' || e.key === 'S' || e.key === 'Enter') {
        e.preventDefault()
        // A held key repeats: one press is one Save.
        if (!e.repeat) save(e.key === 'Enter' && e.shiftKey)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [save])

  const discard = () => {
    setAsking(false)
    if (!hold()) return
    void dropDraft(rt.store, id)
      .catch((e: unknown) => noteError('card.draft', e))
      .finally(() => leave())
  }
  const cancel = () => (dirty ? setAsking(true) : leave())
  // Back with unsaved changes asks once instead of leaving.

  if (card === null) return <NotFound />
  const courseId = card.courseId
  const home = to.place(courseId, card.sectionId)
  const remove = () => {
    void dropDraft(rt.store, id).catch((e: unknown) => noteError('card.draft', e))
    ws.cards.trash(id)
    // The course offers Undo for a few moments instead of asking first.
    const state: CardNotice = { trashedCard: id }
    leaveTo(home, state)
  }
  // Shares what the editor shows (the draft), with its photos as files.
  const share = () => {
    setShareStatus(null)
    import('../Photos/share.ts')
      .then(({ shareCard }) =>
        shareCard({ front: fields.front, back: fields.back, title: fields.front.split('\n')[0] ?? '' }, loadFile),
      )
      .then(
        (outcome) => {
          if (outcome !== 'cancelled')
            setShareStatus(outcome === 'shared' ? t('photos.shared') : t('photos.downloaded'))
        },
        (e: unknown) => {
          noteError('card.share', e)
          setShareStatus(t('photos.actionFailed'))
        },
      )
  }
  const shortcut = MAC ? '⌘S' : 'Ctrl+S'
  const nextShortcut = MAC ? '⇧⌘↩' : 'Ctrl+Shift+Enter'
  // A new card: writing cards on the fly, the main action saves this one and starts the next one in the same place.
  const saveButtons = (
    <>
      <Button
        variant={newCourse === null ? 'primary' : 'secondary'}
        onClick={() => save()}
        disabled={!dirty || saving}
        aria-keyshortcuts="Meta+S Control+S Meta+Enter"
        title={`${t('course.save')} (${shortcut})`}
      >
        {t('course.save')}
        <Keycap>{shortcut}</Keycap>
      </Button>
      {newCourse !== null && (
        <Button
          variant="primary"
          onClick={() => save(true)}
          disabled={!dirty || saving}
          aria-keyshortcuts="Meta+Shift+Enter Control+Shift+Enter"
          title={`${t('course.saveAndNext')} (${nextShortcut})`}
        >
          {t('course.saveAndNext')}
          <Keycap>{nextShortcut}</Keycap>
        </Button>
      )}
    </>
  )
  const status = dirty
    ? t('course.unsaved')
    : newCourse === null
      ? t('course.saved')
      : added
        ? t('course.cardAdded')
        : ''

  return (
    <div ref={pageRef} className={styles.page}>
      <Screen
        title={t('common.cardTitle')}
        back={home}
        backOptions={backHome(home)}
        trailing={<div className={styles.top}>{saveButtons}</div>}
      >
        <p className={styles.status} role="status">
          {card.relocated ? `${t('course.sectionGoneSaveIn', { place: card.relocated })} ` : ''}
          {movedTo !== null ? `${t('course.moved', { place: movedTo })} ` : ''}
          {shareStatus !== null ? `${shareStatus} ` : ''}
          {conflict && dirty ? `${t('course.changedElsewhere')} ` : ''}
          {restored && dirty && !conflict ? `${t('course.draftRestored')} ` : ''}
          {status}
        </p>
        {card.from !== null && (
          <p className={styles.help} data-testid="card-from">
            <Link
              href={
                card.from.unit === null
                  ? to.source(card.from.id)
                  : `${to.source(card.from.id)}?page=${card.from.unit.n}`
              }
            >
              {card.from.unit === null
                ? t('course.cardFrom', { source: card.from.title })
                : t('course.cardFromUnit', {
                    source: card.from.title,
                    unit:
                      card.from.unit.kind === 'slide'
                        ? t('ai.deckSlide', { n: card.from.unit.n })
                        : t('ai.deckPage', { n: card.from.unit.n }),
                  })}
            </Link>
          </p>
        )}
        {draft === null ? (
          <p className={styles.status}>{t('common.loading')}</p>
        ) : (
          <div className={styles.form}>
            <Segmented<Kind>
              label={t('course.cardKind')}
              value={kind}
              onChange={setKind}
              options={[
                { value: 'basic', label: t('course.kindBasic') },
                { value: 'cloze', label: t('course.kindCloze') },
              ]}
            />
            <section className={styles.side} aria-labelledby="card-front" onFocus={raise}>
              <h2 id="card-front" className={styles.label}>
                {kind === 'cloze' ? t('course.clozeText') : t('course.front')}
              </h2>
              <MarkdownEditor
                text={draft.front}
                label={kind === 'cloze' ? t('course.clozeText') : t('course.front')}
                cloze={kind === 'cloze'}
                photos={{ courseId: card.courseId, sectionId: card.sectionId ?? undefined }}
                // A new card: the cursor waits in the front, ready to type (the next one after « Save and add
                // another » too).
                autoFocus={newCourse !== null}
              />
              <CardPhotos
                text={draft.front}
                value={fields.front}
                courseId={card.courseId}
                sectionId={card.sectionId ?? undefined}
                side={kind === 'cloze' ? t('course.clozeText') : t('course.front')}
              />
            </section>
            {kind === 'cloze' && <ClozePreview value={fields.front} />}
            <section className={styles.side} aria-labelledby="card-back" onFocus={raise}>
              <h2 id="card-back" className={styles.label}>
                {kind === 'cloze' ? t('course.extra') : t('course.back')}
              </h2>
              <MarkdownEditor
                text={draft.back}
                label={kind === 'cloze' ? t('course.extra') : t('course.back')}
                photos={{ courseId: card.courseId, sectionId: card.sectionId ?? undefined }}
              />
              <CardPhotos
                text={draft.back}
                value={fields.back}
                courseId={card.courseId}
                sectionId={card.sectionId ?? undefined}
                side={kind === 'cloze' ? t('course.extra') : t('course.back')}
              />
            </section>
          </div>
        )}
        {/* The actions come with the form: shown under "Loading…", they would jump down as it arrives, and a tap
            already on its way would land on the form instead. */}
        {draft !== null && (
          <div className={styles.actions}>
            <Button variant="plain" onClick={cancel}>
              {t('course.cancel')}
            </Button>
            {newCourse === null && (
              <>
                {aiReady && !dirty && (
                  <Button
                    variant="plain"
                    icon={<Wand2 size={18} aria-hidden="true" />}
                    onClick={() => setImproving(true)}
                  >
                    {t('review.improve')}
                  </Button>
                )}
                <Button variant="plain" icon={<Share size={18} aria-hidden="true" />} onClick={share}>
                  {t('photos.shareCard')}
                </Button>
                <Link href={to.history(id)} className={buttonClass({ variant: 'plain' })}>
                  <History size={18} aria-hidden="true" />
                  {t('course.history')}
                </Link>
                <Button
                  variant="plain"
                  icon={<FolderInput size={18} aria-hidden="true" />}
                  onClick={() => setMoving(true)}
                >
                  {t('course.moveTo')}
                </Button>
                <Button variant="danger" icon={<Trash2 size={18} aria-hidden="true" />} onClick={remove}>
                  {t('course.moveToTrash')}
                </Button>
              </>
            )}
          </div>
        )}
        <div className={cx(styles.bottom, newCourse !== null && styles.pair)}>{saveButtons}</div>
        <div className={styles.room} aria-hidden="true" />
        {improving && (
          <Suspense fallback={null}>
            <ImproveSheet cardId={id} revealed onClose={() => setImproving(false)} onUsed={setRewritten} />
          </Suspense>
        )}
        {rewritten && (
          <Toast
            message={t('review.improved')}
            actions={[
              {
                label: t('common.undo'),
                onClick: () => {
                  replaceFaces(rt.ws, rewritten.cardId, rewritten.front, rewritten.back)
                  setRewritten(null)
                },
              },
              { label: t('common.dismiss'), onClick: () => setRewritten(null) },
            ]}
          />
        )}
      </Screen>
      {newCourse === null && (
        <MoveSheet
          open={moving}
          title={t('course.moveTitle')}
          onClose={() => setMoving(false)}
          current={{ courseId, sectionId: card.sectionId }}
          onMove={(place) => moveItemTo(ws, 'cards', id, place)}
          onMoved={setMovedTo}
        />
      )}
      <Sheet open={asking} title={t('course.discardTitle')} onClose={() => setAsking(false)}>
        <p className={styles.help}>{t('course.discardBody')}</p>
        <div className={styles.actions}>
          <Button variant="danger" onClick={discard}>
            {t('course.discard')}
          </Button>
          <Button onClick={() => setAsking(false)}>{t('course.keepEditing')}</Button>
        </div>
      </Sheet>
    </div>
  )
}
