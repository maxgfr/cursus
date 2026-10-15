import { FileUp, Presentation, Sparkles } from 'lucide-react'
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'
import { paths, to } from '../../app/routes.ts'
import { useRuntime, useWorkspaceData } from '../../app/workspaceContext.tsx'
import { importDeck, titleFromName } from '../../core/content/deck'
import { useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { proposeFor } from '../../ui/data/autoQuestions.ts'
import { Screen } from '../../ui/shell/Screen.tsx'
import { useScopeOnce } from '../Section/scope.ts'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from './DeckImport.module.css'
import { DeckUnitList } from './DeckUnitList.tsx'
import { DECK_ACCEPT, deckErrorMessage, isDeckFile, type LoadedDeck, saveDeckSource, unitCount } from './deckSource.ts'
import { type Place, PlacePicker } from './places.tsx'
import { useUnitThumbs } from './thumbs.ts'

type Phase =
  | { step: 'choose' }
  | { step: 'reading'; name: string }
  | { step: 'failed'; message: string }
  | { step: 'saved'; sourceId: string; loaded: LoadedDeck; title: string }

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/**
 * « Créer les questions depuis un support », step one: a .pptx, .docx or .pdf is read on this device, saved as a
 * source of the course straight away (nothing is lost if the AI step is skipped), then previewed slide by slide
 * or section by section before questions are made from it.
 */
export default function DeckImport() {
  const t = useT()
  const rt = useRuntime()
  const opened = useScopeOnce()
  const courses = useWorkspaceData(['courses'], (ws) => ws.courses.list())
  const [place, setPlace] = useState<Place>(() => ({
    courseId: opened?.courseId ?? '',
    sectionId: opened?.sectionId ?? '',
  }))
  const [phase, setPhase] = useState<Phase>({ step: 'choose' })
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const thumbs = useUnitThumbs(phase.step === 'saved' ? phase.loaded : null)

  // Default to the first course when the screen was not opened from one.
  useEffect(() => {
    const first = courses[0]
    if (place.courseId === '' && first) setPlace({ courseId: first.id, sectionId: '' })
  }, [courses, place.courseId])

  const decks = useWorkspaceData(['sources', 'sections', { id: place.courseId }], (ws) =>
    place.courseId === ''
      ? []
      : ws.sources.list({ courseId: place.courseId }).filter((s) => s.support !== undefined && s.photo === undefined),
  )

  const read = useCallback(
    async (file: File) => {
      if (place.courseId === '' || phase.step === 'reading') return
      setPhase({ step: 'reading', name: file.name })
      const where = place.sectionId === '' ? { courseId: place.courseId } : place
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const deck = await importDeck(bytes, { name: file.name })
        const title = deck.title.trim() || titleFromName(file.name) || t('ai.deckUntitled')
        const loaded = { deck, bytes }
        const sourceId = await saveDeckSource(rt, where, loaded, title)
        void proposeFor(rt, sourceId)
        setPhase({ step: 'saved', sourceId, loaded, title })
      } catch (e) {
        noteError('deck.import', e)
        setPhase({ step: 'failed', message: deckErrorMessage(t, e) })
      }
    },
    [place, phase.step, rt, t],
  )

  // ⌘V / Ctrl V or drag and drop of a file, anywhere on the screen (pastes into a text field are left alone).
  const choosing = phase.step !== 'saved'
  useEffect(() => {
    if (!choosing) return
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') === true
    const onPaste = (event: ClipboardEvent) => {
      if (isEditable(event.target)) return
      const file = Array.from(event.clipboardData?.files ?? []).find(isDeckFile)
      if (!file) return
      event.preventDefault()
      void read(file)
    }
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setOver(true)
    }
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setOver(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setOver(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      const file = files.find(isDeckFile) ?? files[0]
      if (file) void read(file)
    }
    document.addEventListener('paste', onPaste)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [read, choosing])

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (file) void read(file)
  }

  const back = place.courseId === '' ? paths.courses : to.place(place.courseId, place.sectionId)

  if (courses.length === 0) {
    return (
      <Screen title={t('ai.deckImportTitle')} back={paths.courses}>
        <EmptyState
          icon={Presentation}
          title={t('ai.deckNeedCourseTitle')}
          body={t('ai.needCourse')}
          action={
            <Link href={paths.courses} className={buttonClass({ variant: 'primary' })}>
              {t('ai.deckOpenCourses')}
            </Link>
          }
        />
      </Screen>
    )
  }

  if (phase.step === 'saved') {
    const { deck } = phase.loaded
    const skipped = deck.warnings.filter((w) => w.startsWith('image-')).length
    return (
      <Screen title={phase.title} back={back}>
        <div className={styles.stack}>
          <div className={styles.summary} role="status">
            <p className={styles.summaryTitle}>{unitCount(t, deck)}</p>
            <p className={styles.hint}>{t('ai.deckSavedSource')}</p>
            {skipped > 0 && <p className={styles.hint}>{t('ai.deckImagesSkipped', { count: skipped })}</p>}
            {deck.warnings.some((w) => w.startsWith('unit-limit')) && (
              <p className={styles.hint}>{t('ai.deckUnitLimit', { count: deck.units.length })}</p>
            )}
          </div>
          <div className={styles.row}>
            <Link href={to.deckQuestions(phase.sourceId)} className={buttonClass({ variant: 'primary' })}>
              <Sparkles size={18} aria-hidden="true" />
              {t('ai.deckCreateQuestions')}
            </Link>
            <Link href={to.source(phase.sourceId)} className={buttonClass({ variant: 'secondary' })}>
              {t('ai.deckOpenSource')}
            </Link>
            <Button variant="plain" onClick={() => setPhase({ step: 'choose' })}>
              {t('ai.deckImportAnother')}
            </Button>
          </div>
          <section className={styles.tight} aria-labelledby="deck-contents">
            <h2 id="deck-contents" className={styles.heading}>
              {t('ai.deckContents')}
            </h2>
            {deck.units.length === 0 ? (
              <p className={styles.hint}>{t('ai.deckEmpty')}</p>
            ) : (
              <DeckUnitList deck={deck} thumbs={thumbs} detail="preview" />
            )}
          </section>
        </div>
      </Screen>
    )
  }

  const reading = phase.step === 'reading'
  return (
    <Screen title={t('ai.deckImportTitle')} back={back}>
      <div className={styles.stack}>
        <PlacePicker value={place} onChange={setPlace} courseLabel={t('ai.course')} sectionLabel={t('ai.deckSaveIn')} />
        {/* A drop target for the Mac and iPad; the button opens the system picker (Files, iCloud Drive). */}
        <div className={styles.drop} data-over={over ? 'true' : undefined}>
          <Button
            variant="primary"
            icon={<FileUp size={18} aria-hidden="true" />}
            loading={reading}
            onClick={() => input.current?.click()}
          >
            {t('ai.deckChooseFile')}
          </Button>
          <p className={styles.dropText}>{t('ai.deckDropHint')}</p>
          <input
            ref={input}
            className="sr-only"
            type="file"
            accept={DECK_ACCEPT}
            aria-label={t('ai.deckChooseFile')}
            tabIndex={-1}
            onChange={onPick}
          />
        </div>
        {reading && (
          <p className={styles.hint} role="status">
            {t('ai.deckReading', { name: phase.name })}
          </p>
        )}
        {phase.step === 'failed' && (
          <p className={styles.error} role="alert">
            {phase.message}
          </p>
        )}
        {decks.length > 0 && (
          <ListGroup title={t('ai.deckAlreadyImported')}>
            {decks.map((s) => (
              <ListRow
                key={s.id}
                href={to.deckQuestions(s.id)}
                leading={<Presentation size={20} />}
                title={s.title}
                subtitle={t('ai.deckCreateQuestions')}
              />
            ))}
          </ListGroup>
        )}
      </div>
    </Screen>
  )
}
