import { FolderInput, History, Share, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'wouter'
import * as Y from 'yjs'
import { backHome, goBack, leaveTo } from '../../app/nav.ts'
import { to } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { PATH_SEPARATOR } from '../../core/model/sections'
import { useT } from '../../i18n/react.tsx'
import { beforeUpdate } from '../../pwa/index.ts'
import { useChatContext } from '../../ui/chat/context.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Keycap } from '../../ui/components/Keycap.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { MarkdownEditor } from '../../ui/editor/MarkdownEditor.tsx'
import { MoveSheet, moveItemTo } from '../../ui/MoveSheet.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import type { CardNotice } from '../Course/index.tsx'
import { applyForward } from '../History/replay.ts'
import NotFound from '../NotFound/index.tsx'
import CardPhotos from '../Photos/CardPhotos.tsx'
import { useFileLoader } from '../Photos/files.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './CardEditor.module.css'
import { ClozeAssistant } from './ClozeAssistant.tsx'
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

export default function CardEditor() {
  const t = useT()
  const rt = useRuntime()
  const ws = rt.ws
  const { id = '' } = useParams<{ id: string }>()
  const newCourse = newCardCourse(id)
  const newSection = newCardSection(id)
  const card = useWorkspaceData(['cards', 'courses', 'sections', { id }], (w) => {
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
      return { courseId: newCourse, sectionId, saved: null, relocated }
    }
    const c = w.cards.get(id)
    if (!c || c.deletedAt !== undefined) return null
    const saved: CardFields = {
      kind: c.kind,
      front: w.text({ id: c.id, field: 'front' }).toString(),
      back: w.text({ id: c.id, field: 'back' }).toString(),
    }
    return { courseId: c.courseId, sectionId: w.sections.tree().sectionOf(c), saved, relocated: null }
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
          ...(saved.front.trim() ? { card: { front: saved.front, back: saved.back, revealed: true } } : {}),
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
  const [justSaved, setJustSaved] = useState(false)
  const [asking, setAsking] = useState(false)
  const [moving, setMoving] = useState(false)
  const [movedTo, setMovedTo] = useState<string | null>(null)
  const [shareStatus, setShareStatus] = useState<string | null>(null)
  const loadFile = useFileLoader()
  const formRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const exists = card !== null

  // Seed the draft once per card: an unsaved draft kept on this device wins over the saved card.
  useEffect(() => {
    if (!exists) return
    let live = true
    readDraft(rt.store, id).then(
      (kept) => {
        if (!live) return
        const b = kept?.base ?? savedRef.current
        const seed = kept?.fields ?? savedRef.current
        setRestored(kept !== null && !sameFields(kept.fields, b))
        setBase(b)
        setKind(seed.kind)
        setFields(seed)
        setDraft(scratch(seed))
      },
      (e: unknown) => {
        noteError('card.draft', e)
        if (live) {
          setBase(savedRef.current)
          setKind(savedRef.current.kind)
          setFields(savedRef.current)
          setDraft(scratch(savedRef.current))
        }
      },
    )
    return () => {
      live = false
    }
  }, [rt, id, exists])

  // Every keystroke updates the draft (and its copy on this device), never the card.
  useEffect(() => {
    if (!draft) return
    const update = () => {
      setFields((f) => ({ ...f, front: draft.front.toString(), back: draft.back.toString() }))
      setJustSaved(false)
    }
    draft.doc.on('update', update)
    return () => draft.doc.off('update', update)
  }, [draft])
  const current = useMemo<CardFields>(() => ({ ...fields, kind }), [fields, kind])
  const dirty =
    draft !== null && (newCourse !== null ? current.front !== '' || current.back !== '' : !sameFields(current, base))

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

  const save = useCallback(() => {
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
    // Saved means on disk before leaving, not at the next idle seal.
    void Promise.all([rt.seal(), dropDraft(rt.store, id)])
      .catch((e: unknown) => noteError('card.save', e))
      .finally(() => leave(newCourse !== null ? { cardSaved: true, cardAdded: true } : { cardSaved: true }))
  }, [dirty, card, draft, hold, release, newCourse, create, current, ws, id, base, rt, leave])

  // A new card: the cursor waits in the front, ready to type (the next card after « New card » too).
  useEffect(() => {
    if (newCourse === null || draft === null) return
    formRef.current?.querySelector<HTMLElement>('[contenteditable="true"], textarea')?.focus()
  }, [newCourse, draft])

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

  // ⌘S / Ctrl+S and ⌘Enter save from anywhere in the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 's' || e.key === 'S' || e.key === 'Enter') {
        e.preventDefault()
        // A held key repeats: one press is one Save.
        if (!e.repeat) save()
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
  const saveButton = (
    <Button
      variant="primary"
      onClick={save}
      disabled={!dirty || saving}
      aria-keyshortcuts="Meta+S Control+S Meta+Enter"
      title={`${t('course.save')} (${shortcut})`}
    >
      {t('course.save')}
      <Keycap>{shortcut}</Keycap>
    </Button>
  )
  const status = dirty ? t('course.unsaved') : justSaved || newCourse === null ? t('course.saved') : ''

  return (
    <div ref={pageRef} className={styles.page}>
      <Screen
        title={t('common.cardTitle')}
        back={home}
        backOptions={backHome(home)}
        trailing={<div className={styles.top}>{saveButton}</div>}
      >
        <p className={styles.status} role="status">
          {card.relocated ? `${t('course.sectionGoneSaveIn', { place: card.relocated })} ` : ''}
          {movedTo !== null ? `${t('course.moved', { place: movedTo })} ` : ''}
          {shareStatus !== null ? `${shareStatus} ` : ''}
          {conflict && dirty ? `${t('course.changedElsewhere')} ` : ''}
          {restored && dirty && !conflict ? `${t('course.draftRestored')} ` : ''}
          {status}
        </p>
        {draft === null ? (
          <p className={styles.status}>{t('common.loading')}</p>
        ) : (
          <div ref={formRef} className={styles.form}>
            <Segmented<Kind>
              label={t('course.cardKind')}
              value={kind}
              onChange={(k) => {
                setKind(k)
                setJustSaved(false)
              }}
              options={[
                { value: 'basic', label: t('course.kindBasic') },
                { value: 'cloze', label: t('course.kindCloze') },
              ]}
            />
            <section className={styles.side} aria-labelledby="card-front">
              <h2 id="card-front" className={styles.label}>
                {kind === 'cloze' ? t('course.clozeText') : t('course.front')}
              </h2>
              <MarkdownEditor text={draft.front} label={kind === 'cloze' ? t('course.clozeText') : t('course.front')} />
              <CardPhotos
                text={draft.front}
                value={fields.front}
                courseId={card.courseId}
                sectionId={card.sectionId ?? undefined}
                side={kind === 'cloze' ? t('course.clozeText') : t('course.front')}
              />
            </section>
            {kind === 'cloze' && <ClozeAssistant text={draft.front} value={fields.front} />}
            <section className={styles.side} aria-labelledby="card-back">
              <h2 id="card-back" className={styles.label}>
                {kind === 'cloze' ? t('course.extra') : t('course.back')}
              </h2>
              <MarkdownEditor text={draft.back} label={kind === 'cloze' ? t('course.extra') : t('course.back')} />
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
        <div className={styles.bottom}>{saveButton}</div>
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
