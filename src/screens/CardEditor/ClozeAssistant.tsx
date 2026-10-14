import { type FormEvent, useState } from 'react'
import type * as Y from 'yjs'
import { useWorkspace } from '../../app/workspaceContext.tsx'
import { clozeIndexes, makeClozeCards } from '../../core/model/cloze'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import styles from './CardEditor.module.css'

/**
 * Turns a phrase of the front into the next `{{cN::…}}` deletion and previews the cards it makes.
 * Edits go through the card's own Y.Text, like typing in the editor.
 */
export function ClozeAssistant({ text, value }: { text: Y.Text; value: string }) {
  const t = useT()
  const ws = useWorkspace()
  const [phrase, setPhrase] = useState('')
  const [hint, setHint] = useState('')
  const [miss, setMiss] = useState(false)
  const cards = makeClozeCards(value)

  const hide = (e: FormEvent) => {
    e.preventDefault()
    const target = phrase.trim()
    if (target === '') return
    const at = value.indexOf(target)
    if (at < 0) {
      setMiss(true)
      return
    }
    const next = (clozeIndexes(value).at(-1) ?? 0) + 1
    const h = hint.trim()
    const cloze = `{{c${next}::${target}${h === '' ? '' : `::${h}`}}}`
    ws.batch(() => {
      text.delete(at, target.length)
      text.insert(at, cloze)
    })
    setPhrase('')
    setHint('')
    setMiss(false)
  }

  return (
    <section className={styles.assistant} aria-labelledby="cloze-title">
      <h2 id="cloze-title" className={styles.label}>
        {t('course.clozeTitle')}
      </h2>
      <p className={styles.help}>{t('course.clozeHelp')}</p>
      <form className={styles.clozeForm} onSubmit={hide}>
        <Field
          label={t('course.clozePhrase')}
          value={phrase}
          onChange={(e) => {
            setPhrase(e.currentTarget.value)
            setMiss(false)
          }}
          error={miss ? t('course.clozeNotFound') : undefined}
          autoComplete="off"
          enterKeyHint="done"
        />
        <Field
          label={t('course.clozeHint')}
          value={hint}
          onChange={(e) => setHint(e.currentTarget.value)}
          autoComplete="off"
        />
        <Button type="submit" disabled={phrase.trim() === ''}>
          {t('course.clozeHide')}
        </Button>
      </form>
      {cards.length > 0 && (
        <ol className={styles.preview} aria-label={t('course.clozePreview', { count: cards.length })}>
          {cards.map((c) => (
            <li key={c.index} className={styles.previewItem}>
              <span className={styles.previewIndex}>{c.index}</span>
              <span>{c.front}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
