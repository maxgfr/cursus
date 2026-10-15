import {
  Camera,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Image,
  Images,
  Layers,
  NotebookText,
  PenLine,
  Play,
  Plus,
  Presentation,
  Settings2,
  Sparkles,
} from 'lucide-react'
import { type ChangeEvent, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { type Captured, usePasteCapture } from '../../app/paste.ts'
import { paths, to, withScope } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id, StudyScope } from '../../core/contracts/workspace'
import type { SourceRecord } from '../../core/model/schema'
import { useT } from '../../i18n/react.tsx'
import { Breadcrumb } from '../../ui/Breadcrumb.tsx'
import { useChatContext } from '../../ui/chat/context.tsx'
import { courseHue } from '../../ui/components/Badges.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { proposeFor, proposeWhenWritten } from '../../ui/data/autoQuestions.ts'
import { MoveSheet, moveItemTo, type Place } from '../../ui/MoveSheet.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { newCardId } from '../CardEditor/draft.ts'
import NotFound from '../NotFound/index.tsx'
import { startQueue } from '../Review/session.ts'
import { NewSectionSheet, SectionSettings } from '../Section/SectionSheets.tsx'
import { addImage, addNote, addPdf } from '../Source/importers.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { ExamCountdown } from '../Today/CourseRows.tsx'
import { backTarget, earlierPaths } from './backTarget.ts'
import styles from './Course.module.css'
import { CourseSettings } from './CourseSettings.tsx'
import { DraftsLine } from './DraftsLine.tsx'

type Tab = 'cards' | 'sources' | 'fiches'

/** History state the course leaves itself: a trashed card or section to undo, or a calm "saved". */
export interface CardNotice {
  trashedCard?: string
  trashedSection?: string
  cardSaved?: boolean
}

const stateString = (state: unknown, key: 'trashedCard' | 'trashedSection'): string | null => {
  if (typeof state !== 'object' || state === null || !(key in state)) return null
  const v = (state as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : null
}

const savedFrom = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && 'cardSaved' in state && state.cardSaved === true

const KIND_ICON = { note: FileText, pdf: FileText, image: Image } as const

type T = ReturnType<typeof useT>

/** How a source is named in the list: a .pptx or .docx is kept as `note` for older clients, its `support` says what it is. */
function sourceKind(t: T, s: Pick<SourceRecord, 'kind' | 'support'>): { icon: typeof FileText; label: string } {
  if (s.kind === 'pdf') return { icon: FileText, label: t('course.kindPdf') }
  if (s.kind === 'image') return { icon: Image, label: t('course.kindPhoto') }
  if (s.support === 'deck') return { icon: Presentation, label: t('ai.kindSlides') }
  if (s.support === 'document') return { icon: FileText, label: t('ai.kindDocument') }
  return { icon: KIND_ICON[s.kind], label: t('course.kindNote') }
}

/** A course root (no `sectionId`) or one of its sections: its subsets first, then its own items. */
export function CourseView({ courseId, sectionId }: { courseId: Id; sectionId?: Id }) {
  const t = useT()
  const rt = useRuntime()
  const [, navigate] = useLocation()
  const [tab, setTab] = useState<Tab>('cards')
  const [settings, setSettings] = useState(false)
  const [adding, setAdding] = useState(false)
  const [moving, setMoving] = useState<{ kind: 'section' | 'fiches'; id: Id; name: string } | null>(null)
  const [moved, setMoved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trashed, setTrashed] = useState<string | null>(() => stateString(history.state, 'trashedCard'))
  const [trashedSection, setTrashedSection] = useState<string | null>(() =>
    stateString(history.state, 'trashedSection'),
  )
  const [saved, setSaved] = useState(() => savedFrom(history.state))
  const back = useMemo(() => backTarget(earlierPaths()), [])
  const pdfInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const here = sectionId ?? null
  useChatContext(sectionId === undefined ? { courseId } : { courseId, sectionId })
  const data = useWorkspaceData(
    ['courses', 'sections', 'cards', 'sources', 'fiches', { id: sectionId ?? courseId }],
    (ws) => {
      const course = ws.courses.get(courseId)
      if (!course || course.deletedAt !== undefined) return null
      const tree = ws.sections.tree()
      const section = sectionId === undefined ? null : (tree.get(sectionId) ?? null)
      if (sectionId !== undefined && (section === null || section.courseId !== courseId || tree.hidden(sectionId)))
        return null
      const atHere = (e: { courseId: Id; sectionId?: Id }) => tree.sectionOf(e) === here
      const scope: StudyScope = sectionId === undefined ? { courseId } : { courseId, sectionId }
      const children = tree.children(courseId, here)
      return {
        course,
        section,
        path: section === null ? [] : tree.chain(section.id).slice(0, -1),
        siblings: section === null ? [] : tree.children(courseId, tree.parent(section.id)).map((s) => s.id),
        children: children.map((s) => ({
          id: s.id,
          name: s.name,
          examDate: s.examDate,
          cards: ws.scoped('cards', { courseId, sectionId: s.id }).length,
        })),
        trashedChildren: tree
          .children(courseId, here, { trashed: true })
          .filter((s) => s.deletedAt !== undefined)
          .map((s) => ({ id: s.id, name: s.name })),
        total: ws.scoped('cards', scope).length,
        cards: ws.cards
          .list({ courseId })
          .filter(atHere)
          .map((c) => ({
            id: c.id,
            kind: c.kind,
            front: ws.text({ id: c.id, field: 'front' }).toString().split('\n')[0] ?? '',
          })),
        sources: ws.sources.list({ courseId }).filter(atHere),
        fiches: ws.fiches.list({ courseId }).filter(atHere),
      }
    },
  )
  // A section's own Start: today's queue limited to it and its descendants.
  const due = useWorkspaceData(['cards', 'sections', 'reviews', 'prefs', { id: sectionId ?? courseId }], (ws) =>
    sectionId === undefined ? 0 : startQueue(ws, Date.now(), { courseId, sectionId }).queue.length,
  )
  const where = sectionId === undefined ? { courseId } : { courseId, sectionId }

  /** Adds a source and opens it; its questions are proposed (per « When I add a document »). */
  const run = async (work: () => Promise<string>) => {
    setBusy(true)
    setError(null)
    try {
      const id = await work()
      void proposeFor(rt, id)
      navigate(to.source(id))
    } catch (e) {
      noteError('course.import', e)
      setError(t('course.importFailed'))
    } finally {
      setBusy(false)
    }
  }

  usePasteCapture(
    (c: Captured) => {
      if (c.kind === 'image') void run(() => addImage(rt, where, c.blob, c.name, t('course.untitledPhoto')))
      else {
        const id = addNote(rt, where, t('course.pastedNote'), c.text)
        void proposeFor(rt, id)
        navigate(to.source(id))
      }
    },
    { enabled: data !== null && tab === 'sources' && !settings && !adding && moving === null },
  )

  if (data === null) return <NotFound />
  const { course, section, cards, sources, fiches, children } = data
  const scope: StudyScope = where
  const parentHref = section === null ? back : to.place(courseId, data.path.at(-1)?.id)

  // The card is created only when its editor saves: no empty cards in the library.
  const newCard = () => navigate(to.card(newCardId(courseId, sectionId)))
  const dismissTrashed = () => {
    setTrashed(null)
    setTrashedSection(null)
    history.replaceState(null, '', location.href)
  }
  const undoTrash = (cardId: string) => {
    rt.ws.cards.restore(cardId)
    dismissTrashed()
  }
  const undoSection = (id: string) => {
    rt.ws.sections.restore(id)
    dismissTrashed()
  }
  const newNote = () => {
    const id = addNote(rt, where, t('course.untitledNote'))
    // Empty for now: proposed once the student leaves it with something written.
    proposeWhenWritten(id)
    navigate(to.source(id))
  }
  const onPdf = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (file) void run(() => addPdf(rt, where, file, t('course.untitledPdf')))
  }
  const onPhoto = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (file) void run(() => addImage(rt, where, file, file.name, t('course.untitledPhoto')))
  }
  const trashSection = () => {
    if (section === null) return
    rt.ws.sections.trash(section.id)
    setSettings(false)
    const notice: CardNotice = { trashedSection: section.id }
    navigate(parentHref, { state: notice })
  }
  const move = (place: Place) => {
    if (moving === null) return
    if (moving.kind === 'section') rt.ws.sections.move(moving.id, place.sectionId)
    else moveItemTo(rt.ws, moving.kind, moving.id, place)
  }

  // The import buttons: above the list, or inside the empty state when there is nothing yet.
  const sourceActions = (
    <div className={styles.actions}>
      <Button icon={<PenLine size={18} aria-hidden="true" />} onClick={newNote} disabled={busy}>
        {t('course.writeNote')}
      </Button>
      <Button icon={<FileText size={18} aria-hidden="true" />} onClick={() => pdfInput.current?.click()} loading={busy}>
        {t('course.importPdf')}
      </Button>
      <Button
        icon={<Camera size={18} aria-hidden="true" />}
        onClick={() => photoInput.current?.click()}
        disabled={busy}
      >
        {t('course.takePhoto')}
      </Button>
      {/* Slides or a structured document (.pptx, .docx, .pdf), read slide by slide or section by section. */}
      <Link href={withScope(paths.deckImport, scope)} className={buttonClass({})}>
        <Presentation size={18} aria-hidden="true" />
        {t('ai.deckImportAction')}
      </Link>
      {/* The photo gallery of this place (its subsets' photos included): with the sources, never among the cards. */}
      <Link href={to.photos(courseId, sectionId)} className={buttonClass({ variant: 'plain' })}>
        <Images size={18} aria-hidden="true" />
        {t('photos.title')}
      </Link>
      <input
        ref={pdfInput}
        className="sr-only"
        type="file"
        accept="application/pdf,.pdf"
        aria-label={t('course.importPdf')}
        tabIndex={-1}
        onChange={onPdf}
      />
      <input
        ref={photoInput}
        className="sr-only"
        type="file"
        accept="image/*"
        capture="environment"
        aria-label={t('course.takePhoto')}
        tabIndex={-1}
        onChange={onPhoto}
      />
    </div>
  )

  const title = section?.name ?? course.title
  const examDate = section === null ? course.examDate : section.examDate

  return (
    <Screen
      title={title}
      back={parentHref}
      trailing={
        <IconButton
          icon={Settings2}
          label={section === null ? t('course.settings') : t('course.sectionSettings')}
          onClick={() => setSettings(true)}
        />
      }
    >
      {section === null ? (
        <CourseSettings course={course} open={settings} onClose={() => setSettings(false)} />
      ) : (
        <SectionSettings
          section={section}
          siblings={data.siblings}
          open={settings}
          onClose={() => setSettings(false)}
          onMove={() => {
            setSettings(false)
            setMoving({ kind: 'section', id: section.id, name: section.name })
          }}
          onTrash={trashSection}
        />
      )}
      {section !== null && (
        <Breadcrumb
          label={t('course.breadcrumb')}
          crumbs={[
            { label: course.title, href: to.course(courseId) },
            ...data.path.map((s) => ({ label: s.name, href: to.section(courseId, s.id) })),
          ]}
          current={section.name}
        />
      )}
      <p className={styles.meta} data-testid="place-meta">
        <span
          aria-hidden="true"
          className={styles.dot}
          style={{ background: `var(--course-${courseHue(course.color, course.id)})` }}
        />
        <span>{t('course.cardCount', { count: data.total })}</span>
        {section !== null && <span>{due > 0 ? t('course.dueInScope', { count: due }) : t('course.nothingDue')}</span>}
        <ExamCountdown examDate={examDate} />
      </p>
      {section === null && <DraftsLine courseId={courseId} />}
      {(section !== null || data.total > 0) && (
        <div className={styles.study}>
          {section !== null && due > 0 && (
            <Button variant="primary" onClick={() => navigate(withScope(paths.review, scope))}>
              {t('common.start')}
            </Button>
          )}
          {section !== null && (
            <Link href={withScope(paths.understand, scope)} className={buttonClass({ variant: 'secondary' })}>
              <Sparkles size={18} aria-hidden="true" />
              {t('course.understand')}
            </Link>
          )}
          {/* A custom session over this course or subset (descendants included). */}
          {data.total > 0 && (
            <Button
              variant="secondary"
              icon={<Play size={18} aria-hidden="true" />}
              onClick={() => navigate(withScope(paths.sessionNew, scope))}
            >
              {t('review.newSession')}
            </Button>
          )}
        </div>
      )}
      {children.length > 0 && (
        <ListGroup title={t('course.sections')}>
          {children.map((s) => (
            <ListRow
              key={s.id}
              href={to.section(courseId, s.id)}
              leading={<Folder size={20} />}
              title={s.name}
              subtitle={t('course.cardCount', { count: s.cards })}
              trailing={<ExamCountdown examDate={s.examDate} />}
            />
          ))}
        </ListGroup>
      )}
      <div className={styles.actions}>
        <Button variant="plain" icon={<FolderPlus size={18} aria-hidden="true" />} onClick={() => setAdding(true)}>
          {t('course.newSection')}
        </Button>
      </div>
      {data.trashedChildren.length > 0 && (
        <ListGroup title={t('course.trashedSections')}>
          {data.trashedChildren.map((s) => (
            <ListRow
              key={s.id}
              leading={<Folder size={20} />}
              title={t('course.restoreItem', { name: s.name })}
              onClick={() => rt.ws.sections.restore(s.id)}
            />
          ))}
        </ListGroup>
      )}
      <Segmented<Tab>
        label={t('common.courseTitle')}
        hideLabel
        value={tab}
        onChange={setTab}
        options={[
          { value: 'cards', label: t('course.tabCards') },
          { value: 'sources', label: t('course.tabSources') },
          { value: 'fiches', label: t('course.tabSheets') },
        ]}
      />
      {tab === 'cards' && (
        <>
          {cards.length > 0 && (
            <div className={styles.actions}>
              <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={newCard}>
                {t('course.addCard')}
              </Button>
            </div>
          )}
          {cards.length === 0 ? (
            <EmptyState
              icon={Layers}
              title={t('course.noCardsTitle')}
              body={t('course.noCardsBody')}
              action={
                <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={newCard}>
                  {t('course.addCard')}
                </Button>
              }
            />
          ) : (
            <ListGroup title={t('course.tabCards')} hideTitle footer={t('course.cardCount', { count: cards.length })}>
              {cards.map((c) => (
                <ListRow
                  key={c.id}
                  href={to.card(c.id)}
                  title={c.front || t('course.emptyCard')}
                  subtitle={c.kind === 'cloze' ? t('course.kindCloze') : undefined}
                />
              ))}
            </ListGroup>
          )}
        </>
      )}
      {tab === 'sources' && (
        <>
          {sources.length > 0 && sourceActions}
          <p className={styles.hint}>{t('course.pasteHint')}</p>
          {sources.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={t('course.noSourcesTitle')}
              body={t('course.noSourcesBody')}
              action={sourceActions}
            />
          ) : (
            <ListGroup title={t('course.tabSources')} hideTitle>
              {sources.map((s) => {
                const { icon: Icon, label } = sourceKind(t, s)
                return (
                  <ListRow
                    key={s.id}
                    href={to.source(s.id)}
                    leading={<Icon size={20} />}
                    title={s.title}
                    subtitle={label}
                  />
                )
              })}
            </ListGroup>
          )}
        </>
      )}
      {tab === 'fiches' &&
        (fiches.length === 0 ? (
          <EmptyState
            icon={NotebookText}
            title={t('course.noSheetsTitle')}
            body={t('course.noSheetsBody')}
            action={
              <Link href={withScope(paths.understand, scope)} className={buttonClass({})}>
                <Sparkles size={18} aria-hidden="true" />
                {t('course.understand')}
              </Link>
            }
          />
        ) : (
          <ListGroup title={t('course.tabSheets')} hideTitle>
            {fiches.map((f) => (
              <ListRow
                key={f.id}
                leading={<NotebookText size={20} />}
                title={f.title}
                trailing={
                  <IconButton
                    icon={FolderInput}
                    label={t('course.moveNamed', { name: f.title })}
                    onClick={() => setMoving({ kind: 'fiches', id: f.id, name: f.title })}
                  />
                }
              />
            ))}
          </ListGroup>
        ))}
      <NewSectionSheet
        courseId={courseId}
        parentId={here}
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(id) => navigate(to.section(courseId, id))}
      />
      <MoveSheet
        open={moving !== null}
        title={moving === null ? t('course.moveTitle') : t('course.moveNamed', { name: moving.name })}
        onClose={() => setMoving(null)}
        current={
          moving?.kind === 'section'
            ? { courseId, sectionId: data.path.at(-1)?.id ?? null }
            : { courseId, sectionId: here }
        }
        courseOnly={moving?.kind === 'section'}
        onMove={move}
        onMoved={(path) => setMoved(t('course.moved', { place: path }))}
      />
      {trashed !== null && error === null && (
        <Toast
          message={t('course.cardTrashed')}
          actions={[
            { label: t('course.undo'), onClick: () => undoTrash(trashed) },
            { label: t('common.dismiss'), onClick: dismissTrashed },
          ]}
        />
      )}
      {trashedSection !== null && trashed === null && error === null && (
        <Toast
          message={t('course.sectionTrashed')}
          actions={[
            { label: t('course.undo'), onClick: () => undoSection(trashedSection) },
            { label: t('common.dismiss'), onClick: dismissTrashed },
          ]}
        />
      )}
      {moved !== null && trashed === null && trashedSection === null && error === null && (
        <Toast message={moved} actions={[{ label: t('common.dismiss'), onClick: () => setMoved(null) }]} />
      )}
      {saved && trashed === null && error === null && (
        <Toast
          message={t('course.cardSaved')}
          actions={[
            {
              label: t('common.dismiss'),
              onClick: () => {
                setSaved(false)
                history.replaceState(null, '', location.href)
              },
            },
          ]}
        />
      )}
      {error !== null && (
        <Toast message={error} actions={[{ label: t('common.dismiss'), onClick: () => setError(null) }]} />
      )}
    </Screen>
  )
}
