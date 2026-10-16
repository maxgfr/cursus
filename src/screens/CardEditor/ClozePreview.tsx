import { makeClozeCards } from '../../core/model/cloze'
import { useT } from '../../i18n/react.tsx'
import styles from './CardEditor.module.css'

/** How to hide a part of the text until there is one, then the cards the text makes, one per blank. */
export function ClozePreview({ value }: { value: string }) {
  const t = useT()
  const cards = makeClozeCards(value)
  if (cards.length === 0) return <p className={styles.help}>{t('course.clozeHelp')}</p>
  return (
    <section className={styles.assistant} aria-labelledby="cloze-title">
      <h2 id="cloze-title" className={styles.label}>
        {t('course.clozePreview', { count: cards.length })}
      </h2>
      <ol className={styles.preview} aria-labelledby="cloze-title">
        {cards.map((c) => (
          <li key={c.index} className={styles.previewItem}>
            <span className={styles.previewIndex}>{c.index}</span>
            <span>{c.front}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
