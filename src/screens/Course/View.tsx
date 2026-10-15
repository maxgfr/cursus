import {
  Download,
  Ellipsis,
  FileText,
  FileUp,
  Folder,
  FolderInput,
  FolderPlus,
  Image,
  Images,
  Layers,
  MessageCircleQuestion,
  NotebookPen,
  NotebookText,
  Play,
  Plus,
  Presentation,
  Settings2,
  Sparkles,
} from 'lucide-react'
import { type ChangeEvent, Suspense, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { lazyChunk } from '../../app/lazyChunk.tsx'
import { clearEntryState, leaveTo } from '../../app/nav.ts'
import { type Captured, usePasteCapture } from '../../app/paste.ts'
import { paths, to, withScope } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Id, StudyScope } from '../../core/contracts/workspace'
import { importCards } from '../../core/export/csvImport'
import { clozePlain } from '../../core/model/cloze'
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
import { Sheet } from '../../ui/components/Sheet.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { proposeFor, proposeWhenWritten } from '../../ui/data/autoQuestions.ts'
import { MoveSheet, moveItemTo, type Place } from '../../ui/MoveSheet.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { newCardId } from '../CardEditor/draft.ts'
import { deckErrorMessage } from '../DeckImport/deckSource.ts'
import NotFound from '../NotFound/index.tsx'
import { startQueue } from '../Review/session.ts'
import { NewSectionSheet, SectionSettings } from '../Section/SectionSheets.tsx'
import { PracticeSheet } from '../Sessions/PracticeSheet.tsx'
import { addFile, addImage, addNote, FILES_ACCEPT } from '../Source/importers.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { ExamCountdown } from '../Today/CourseRows.tsx'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import { AddSheet } from './AddSheet.tsx'
import styles from './Course.module.css'
import { CourseSettings } from './CourseSettings.tsx'
import { DraftsLine } from './DraftsLine.tsx'

// A study sheet opens read only; its renderer loads with it.
const LazyFicheSheet = lazyChunk<import('../../ui/FicheSheet.tsx').FicheSheetProps>(
  'course.ficheSheet',
  () => import('../../ui/FicheSheet.tsx'),
)

type Tab = 'cards' | 'sources' | 'fiches'

/**
 * History state the course is opened with: a trashed card or section to undo, a calm "saved", or the tab to
 * open on (a study sheet just saved opens the course on its study sheets).
 */
export interface CardNotice {
  trashedCard?: string
  trashedSection?: string
  cardSaved?: boolean
  /** The saved card was a new one: the notice offers the next one. */
  cardAdded?: boolean
  tab?: 'fiches'
}

const stateString = (state: unknown, key: 'trashedCard' | 'trashedSection'): string | null => {
  if (typeof state !== 'object' || state === null || !(key in state)) return null
  const v = (state as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : null
}

const savedFrom = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && 'cardSaved' in state && state.cardSaved === true

const addedFrom = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && 'cardAdded' in state && state.cardAdded === true

const tabFrom = (state: unknown): 'fiches' | null =>
  typeof state === 'object' && state !== null && 'tab' in state && state.tab === 'fiches' ? 'fiches' : null

const KIND_ICON = { note: FileText, pdf: FileText, image: Image } as const

type T = ReturnType<typeof useT>

/** How a source is named in the list: a .pptx or .docx is kept as `note` for older clients, its `support` says what it is. */
function sourceKind(t: T, s: Pick<SourceRecord, 'kind' | 'support'>): { icon: typeof FileText; label: string } {
  if (s.support === 'deck') return { icon: Presentation, label: t('ai.kindSlides') }
  if (s.support === 'document') return { icon: FileText, label: t('ai.kindDocument') }
  if (s.kind === 'pdf') return { icon: FileText, label: t('course.kindPdf') }
  if (s.kind === 'image') return { icon: Image, label: t('course.kindPhoto') }
  return { icon: KIND_ICON[s.kind], label: t('course.kindNote') }
}

/** A course root (no `sectionId`) or one of its sections: its subsets first, then its own items. */
export function CourseView({ courseId, sectionId }: { courseId: Id; sectionId?: Id }) {
  const t = useT()
  const rt = useRuntime()
  const [, navigate] = useLocation()
  const [chosenTab, setTab] = useState<Tab | null>(() => tabFrom(history.state))
  const [addingSource, setAddingSource] = useState(false)
  const [moreCards, setMoreCards] = useState(false)
  const [settings, setSettings] = useState(false)
  const [adding, setAdding] = useState(false)
  const [practicing, setPracticing] = useState(false)
  const [moving, setMoving] = useState<{ kind: 'section' | 'fiches'; id: Id; name: string } | null>(null)
  const [moved, setMoved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trashed, setTrashed] = useState<string | null>(() => stateString(history.state, 'trashedCard'))
  const [trashedSection, setTrashedSection] = useState<string | null>(() =>
    stateString(history.state, 'trashedSection'),
  )
  const [saved, setSaved] = useState(() => savedFrom(history.state))
  const [added] = useState(() => addedFrom(history.state))
  const filesInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const csvInput = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState<Id | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const here = sectionId ?? null
  // AI only explains, improves or gets a start: its actions show once a model is ready, never a setup link here.
  const aiReady = useAiModel().status === 'ready'
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
          .map((c) => {
            const front = ws.text({ id: c.id, field: 'front' }).toString()
            // A fill-in-the-blank reads as its sentence, not its markup.
            const shown = c.kind === 'cloze' ? clozePlain(front) : front
            return { id: c.id, kind: c.kind, front: shown.split('\n')[0] ?? '' }
          }),
        sources: ws.sources.list({ courseId }).filter(atHere),
        fiches: ws.fiches.list({ courseId }).filter(atHere),
        // Study sheets kept in the sections below: the tab says where they are rather than that there are none.
        fichesBelow: ws.scoped('fiches', scope).filter((f) => !atHere(f)).length,
      }
    },
  )
  // Start: today's queue limited to this course, or to this section and its descendants.
  const due = useWorkspaceData(
    ['cards', 'sections', 'reviews', 'prefs', { id: sectionId ?? courseId }],
    (ws) => startQueue(ws, Date.now(), sectionId === undefined ? { courseId } : { courseId, sectionId }).queue.length,
  )
  const where = sectionId === undefined ? { courseId } : { courseId, sectionId }
  // Opens on the cards when there are some, else on the sources to add the first one.
  const tab: Tab = chosenTab ?? (data !== null && data.cards.length > 0 ? 'cards' : 'sources')

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

  /** Adds each file by what it is; one file opens, several stay listed under Sources. */
  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    const fallback = {
      note: t('course.untitledNote'),
      photo: t('course.untitledPhoto'),
      pdf: t('course.untitledPdf'),
      deck: t('ai.deckUntitled'),
    }
    const added: Id[] = []
    const failed: string[] = []
    for (const file of files) {
      try {
        const id = await addFile(rt, where, file, fallback)
        added.push(id)
        void proposeFor(rt, id)
      } catch (e) {
        noteError('course.import', e)
        failed.push(t('course.fileFailed', { name: file.name, reason: deckErrorMessage(t, e) }))
      }
    }
    setBusy(false)
    if (failed.length > 0) setError(failed.join(' '))
    const only = added[0]
    if (added.length === 1 && failed.length === 0 && only !== undefined) navigate(to.source(only))
    else if (added.length > 0) {
      setTab('sources')
      setNotice(t('course.filesAdded', { count: added.length }))
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
    {
      enabled: data !== null && tab === 'sources' && !settings && !adding && !addingSource && moving === null,
      onFiles: (files) => void addFiles(files),
    },
  )

  if (data === null) return <NotFound />
  const { course, section, cards, sources, fiches, children } = data
  const scope: StudyScope = where
  const parentHref = section === null ? paths.courses : to.place(courseId, data.path.at(-1)?.id)

  // The card is created only when its editor saves: no empty cards in the library.
  const newCard = () => navigate(to.card(newCardId(courseId, sectionId)))
  const dismissTrashed = () => {
    setTrashed(null)
    setTrashedSection(null)
    clearEntryState()
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
  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files ?? [])
    e.currentTarget.value = ''
    void addFiles(files)
  }
  const onPhoto = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (file) void run(() => addImage(rt, where, file, file.name, t('course.untitledPhoto')))
  }
  const onCsv = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    file.text().then(
      (text) => {
        const { created, skipped } = importCards(rt.ws, courseId, text)
        const parts = [t('common.importCsvDone', { count: created })]
        if (skipped > 0) parts.push(t('common.importCsvSkipped', { count: skipped }))
        setNotice(parts.join(' · '))
      },
      (err: unknown) => {
        noteError('course.csv', err)
        setError(t('errors.unsupportedFile'))
      },
    )
  }
  const trashSection = () => {
    if (section === null) return
    rt.ws.sections.trash(section.id)
    setSettings(false)
    const notice: CardNotice = { trashedSection: section.id }
    // The section is gone: its entry leaves the history, so Back never opens it again.
    leaveTo(parentHref, notice)
  }
  const move = (place: Place) => {
    if (moving === null) return
    if (moving.kind === 'section') rt.ws.sections.move(moving.id, place.sectionId)
    else moveItemTo(rt.ws, moving.kind, moving.id, place)
  }

  const pasteText = () => {
    const open = (text: string) => {
      const id = addNote(rt, where, t('course.pastedNote'), text)
      if (text === '') proposeWhenWritten(id)
      else void proposeFor(rt, id)
      navigate(to.source(id))
    }
    // The clipboard may be refused: the note then opens empty, ready for a long-press paste.
    navigator.clipboard.readText().then(open, (err: unknown) => {
      noteError('course.paste', err)
      open('')
    })
  }

  // One « Add » for every kind of source, next to the photo gallery of this place (its subsets' photos included).
  const sourceActions = (
    <div className={styles.actions}>
      <Button
        variant="primary"
        icon={<Plus size={18} aria-hidden="true" />}
        onClick={() => setAddingSource(true)}
        loading={busy}
      >
        {t('course.add')}
      </Button>
      <Link href={to.photos(courseId, sectionId)} className={buttonClass({ variant: 'plain' })}>
        <Images size={18} aria-hidden="true" />
        {t('photos.title')}
      </Link>
    </div>
  )
  const cardImports = (
    <>
      <Button
        variant="plain"
        icon={<FileUp size={18} aria-hidden="true" />}
        onClick={() => {
          setMoreCards(false)
          csvInput.current?.click()
        }}
      >
        {t('common.importCsv')}
      </Button>
      <Link href={paths.settingsData} className={buttonClass({ variant: 'plain' })}>
        <Download size={18} aria-hidden="true" />
        {t('anki.importTitle')}
      </Link>
    </>
  )

  const newSheet = (
    <Link href={withScope(paths.understand, scope)} className={buttonClass({ variant: 'primary' })}>
      <NotebookPen size={18} aria-hidden="true" />
      {t('course.newSheet')}
    </Link>
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
        {(section !== null || data.total > 0) && (
          <span>{due > 0 ? t('course.dueInScope', { count: due }) : t('course.nothingDue')}</span>
        )}
        <ExamCountdown examDate={examDate} />
      </p>
      {section === null && <DraftsLine courseId={courseId} />}
      {(section !== null || data.total > 0) && (
        <div className={styles.study}>
          {due > 0 && (
            <Button variant="primary" onClick={() => navigate(withScope(paths.review, scope))}>
              {t('common.start')}
            </Button>
          )}
          {aiReady && data.total > 0 && (
            <Link href={withScope(paths.quiz, scope)} className={buttonClass({ variant: 'secondary' })}>
              <MessageCircleQuestion size={18} aria-hidden="true" />
              {t('ai.quiz')}
            </Link>
          )}
          {/* Practice over this course or subset (descendants included): due, all, new, forgotten… in one tap. */}
          {data.total > 0 && (
            <Button
              variant={due > 0 ? 'secondary' : 'primary'}
              icon={<Play size={18} aria-hidden="true" />}
              aria-haspopup="dialog"
              onClick={() => setPracticing(true)}
            >
              {t('review.practiceButton')}
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
          <input
            ref={csvInput}
            className="sr-only"
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            aria-label={t('common.importCsv')}
            tabIndex={-1}
            onChange={onCsv}
          />
          {cards.length > 0 && (
            <div className={styles.actions}>
              <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={newCard}>
                {t('course.addCard')}
              </Button>
              {aiReady && (
                <Link href={withScope(paths.generate, scope)} className={buttonClass({ variant: 'plain' })}>
                  <Sparkles size={18} aria-hidden="true" />
                  {t('ai.generate')}
                </Link>
              )}
              <IconButton icon={Ellipsis} label={t('course.moreCardWays')} onClick={() => setMoreCards(true)} />
            </div>
          )}
          {cards.length === 0 ? (
            <EmptyState
              icon={Layers}
              title={t('course.noCardsTitle')}
              body={t('course.noCardsBody')}
              action={
                <div className={styles.actions}>
                  <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={newCard}>
                    {t('course.addCard')}
                  </Button>
                  {sources.length === 0 || !aiReady ? (
                    <Button icon={<FileText size={18} aria-hidden="true" />} onClick={() => setTab('sources')}>
                      {t('course.addSource')}
                    </Button>
                  ) : (
                    <Link href={withScope(paths.generate, scope)} className={buttonClass({ variant: 'secondary' })}>
                      <Sparkles size={18} aria-hidden="true" />
                      {t('ai.generate')}
                    </Link>
                  )}
                  {cardImports}
                </div>
              }
            />
          ) : (
            <ListGroup
              title={t('course.tabCards')}
              hideTitle
              footer={
                // The cards of this level; the header counts those of its sections too: say both.
                data.total > cards.length
                  ? t('course.cardsHere', { count: cards.length, total: data.total })
                  : t('course.cardCount', { count: cards.length })
              }
            >
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
          <input
            ref={filesInput}
            className="sr-only"
            type="file"
            multiple
            accept={FILES_ACCEPT}
            aria-label={t('course.addFiles')}
            tabIndex={-1}
            onChange={onFiles}
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
      {/* A study sheet is written from the sources on a topic: offered here, where sheets are read, once AI is ready. */}
      {aiReady && tab === 'fiches' && fiches.length > 0 && <div className={styles.actions}>{newSheet}</div>}
      {tab === 'fiches' &&
        (fiches.length === 0 ? (
          <EmptyState
            icon={NotebookText}
            title={data.fichesBelow > 0 ? t('course.sheetsBelowTitle') : t('course.noSheetsTitle')}
            body={
              data.fichesBelow > 0 ? t('course.sheetsBelow', { count: data.fichesBelow }) : t('course.noSheetsBody')
            }
            action={aiReady ? newSheet : undefined}
          />
        ) : (
          <ListGroup title={t('course.tabSheets')} hideTitle>
            {fiches.map((f) => (
              <ListRow
                key={f.id}
                leading={<NotebookText size={20} />}
                title={f.title}
                onClick={() => setReading(f.id)}
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
      <PracticeSheet open={practicing} scope={scope} onClose={() => setPracticing(false)} />
      <AddSheet
        open={addingSource}
        onClose={() => setAddingSource(false)}
        onFiles={() => filesInput.current?.click()}
        onNote={newNote}
        onPhoto={() => photoInput.current?.click()}
        onPaste={pasteText}
      />
      <Sheet open={moreCards} title={t('course.moreCardWays')} onClose={() => setMoreCards(false)}>
        <div className={styles.actions}>{cardImports}</div>
      </Sheet>
      {reading !== null && (
        <Suspense fallback={null}>
          <LazyFicheSheet ficheId={reading} onClose={() => setReading(null)} />
        </Suspense>
      )}
      {notice !== null && error === null && (
        <Toast message={notice} actions={[{ label: t('common.dismiss'), onClick: () => setNotice(null) }]} />
      )}
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
            ...(added
              ? [
                  {
                    label: t('course.addAnother'),
                    onClick: () => {
                      setSaved(false)
                      clearEntryState()
                      newCard()
                    },
                  },
                ]
              : []),
            {
              label: t('common.dismiss'),
              onClick: () => {
                setSaved(false)
                clearEntryState()
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
