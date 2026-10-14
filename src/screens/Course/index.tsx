import { Camera, FileText, Image, Layers, NotebookText, PenLine, Plus, Settings2, Sparkles } from 'lucide-react'
import { type ChangeEvent, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'wouter'
import { type Captured, usePasteCapture } from '../../app/paste.ts'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { courseHue } from '../../ui/components/Badges.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Toast } from '../../ui/components/Toast.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { newCardId } from '../CardEditor/draft.ts'
import NotFound from '../NotFound/index.tsx'
import { addImage, addNote, addPdf } from '../Source/importers.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import { ExamCountdown } from '../Today/CourseRows.tsx'
import { backTarget, earlierPaths } from './backTarget.ts'
import styles from './Course.module.css'
import { CourseSettings } from './CourseSettings.tsx'

type Tab = 'cards' | 'sources' | 'fiches'

/** History state CardEditor leaves: a trashed card the course offers to undo, or a calm "saved". */
export interface CardNotice {
  trashedCard?: string
  cardSaved?: boolean
}

function trashedFrom(state: unknown): string | null {
  return typeof state === 'object' && state !== null && 'trashedCard' in state && typeof state.trashedCard === 'string'
    ? state.trashedCard
    : null
}

const savedFrom = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && 'cardSaved' in state && state.cardSaved === true

const KIND_ICON = { note: FileText, pdf: FileText, image: Image } as const

export default function Course() {
  const t = useT()
  const rt = useRuntime()
  const [, navigate] = useLocation()
  const { id = '' } = useParams<{ id: string }>()
  const [tab, setTab] = useState<Tab>('cards')
  const [settings, setSettings] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trashed, setTrashed] = useState<string | null>(() => trashedFrom(history.state))
  const [saved, setSaved] = useState(() => savedFrom(history.state))
  const back = useMemo(() => backTarget(earlierPaths()), [])
  const pdfInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const data = useWorkspaceData(['courses', 'cards', 'sources', 'fiches'], (ws) => {
    const course = ws.courses.get(id)
    if (!course || course.deletedAt !== undefined) return null
    return {
      course,
      cards: ws.cards.list({ courseId: id }).map((c) => ({
        id: c.id,
        kind: c.kind,
        front: ws.text({ id: c.id, field: 'front' }).toString().split('\n')[0] ?? '',
      })),
      sources: ws.sources.list({ courseId: id }),
      fiches: ws.fiches.list({ courseId: id }),
    }
  })

  const run = async (work: () => Promise<string>) => {
    setBusy(true)
    setError(null)
    try {
      navigate(to.source(await work()))
    } catch (e) {
      noteError('course.import', e)
      setError(t('course.importFailed'))
    } finally {
      setBusy(false)
    }
  }

  usePasteCapture(
    (c: Captured) => {
      if (c.kind === 'image') void run(() => addImage(rt, id, c.blob, c.name, t('course.untitledPhoto')))
      else navigate(to.source(addNote(rt, id, t('course.pastedNote'), c.text)))
    },
    { enabled: data !== null && tab === 'sources' && !settings },
  )

  if (data === null) return <NotFound />
  const { course, cards, sources, fiches } = data

  // The card is created only when its editor saves: no empty cards in the library.
  const newCard = () => navigate(to.card(newCardId(id)))
  const dismissTrashed = () => {
    setTrashed(null)
    history.replaceState(null, '', location.href)
  }
  const undoTrash = (cardId: string) => {
    rt.ws.cards.restore(cardId)
    dismissTrashed()
  }
  const newNote = () => navigate(to.source(addNote(rt, id, t('course.untitledNote'))))
  const onPdf = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (file) void run(() => addPdf(rt, id, file, t('course.untitledPdf')))
  }
  const onPhoto = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (file) void run(() => addImage(rt, id, file, file.name, t('course.untitledPhoto')))
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

  return (
    <Screen
      title={course.title}
      back={back}
      trailing={<IconButton icon={Settings2} label={t('course.settings')} onClick={() => setSettings(true)} />}
    >
      <CourseSettings course={course} open={settings} onClose={() => setSettings(false)} />
      <p className={styles.meta}>
        <span
          aria-hidden="true"
          className={styles.dot}
          style={{ background: `var(--course-${courseHue(course.color, course.id)})` }}
        />
        <span>{t('course.cardCount', { count: cards.length })}</span>
        <ExamCountdown examDate={course.examDate} />
      </p>
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
                const Icon = KIND_ICON[s.kind]
                return (
                  <ListRow
                    key={s.id}
                    href={to.source(s.id)}
                    leading={<Icon size={20} />}
                    title={s.title}
                    subtitle={t(
                      s.kind === 'pdf' ? 'course.kindPdf' : s.kind === 'image' ? 'course.kindPhoto' : 'course.kindNote',
                    )}
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
              <Link href={paths.understand} className={buttonClass({})}>
                <Sparkles size={18} aria-hidden="true" />
                {t('course.understand')}
              </Link>
            }
          />
        ) : (
          <ListGroup title={t('course.tabSheets')} hideTitle>
            {fiches.map((f) => (
              <ListRow key={f.id} leading={<NotebookText size={20} />} title={f.title} />
            ))}
          </ListGroup>
        ))}
      {trashed !== null && error === null && (
        <Toast
          message={t('course.cardTrashed')}
          actions={[
            { label: t('course.undo'), onClick: () => undoTrash(trashed) },
            { label: t('common.dismiss'), onClick: dismissTrashed },
          ]}
        />
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
