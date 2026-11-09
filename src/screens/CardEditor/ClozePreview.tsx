import { clozeTokens, makeClozeCards, toggleClozeToken } from '../../core/model/cloze'
import { useT } from '../../i18n/react.tsx'
import styles from './CardEditor.module.css'

/**
 * The text's words to tap, each hiding or showing one (no selection, no syntax); how to hide a part of the text
 * until there is one; then the cards the text makes, one per blank.
 */
export function ClozePreview({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const t = useT()
  const cards = makeClozeCards(value)
  const tokens = clozeTokens(value)
  return (
    <>
      {cards.length === 0 && <p className={styles.help}>{t('course.clozeHelp')}</p>}
      {tokens.some((x) => x.kind !== 'text') && (
        <section className={styles.assistant} aria-labelledby="cloze-pick">
          <h2 id="cloze-pick" className={styles.label}>
            {t('course.clozePick')}
          </h2>
          <p className={styles.picker}>
            {tokens.map((x) =>
              x.kind === 'text' ? (
                x.text
              ) : (
                <button
                  key={x.from}
                  type="button"
                  className={styles.word}
                  aria-pressed={x.kind === 'blank'}
                  onClick={() => onChange(toggleClozeToken(value, x))}
                >
                  {x.text}
                </button>
              ),
            )}
          </p>
        </section>
      )}
      {cards.length > 0 && (
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
      )}
    </>
  )
}
