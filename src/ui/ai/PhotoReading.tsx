import type { DeepPartial } from 'ai'
import { type ReactNode, useId } from 'react'
import type { PhotoDescription } from '../../core/ai/schemas'
import { useT } from '../../i18n/react.tsx'
import shared from '../../screens/Understand/shared/ai.module.css'
import styles from '../chat/Study.module.css'
import { Sanitized } from '../render/Sanitized.tsx'
import { keyedChoices } from './keyed.ts'

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={shared.label}>
        {title}
      </h3>
      {children}
    </section>
  )
}

/** What a model read on a photo: its title, the text on it, what it means, what to remember. */
export function Reading({ description }: { description: DeepPartial<PhotoDescription> }) {
  const t = useT()
  const points = (description.keyPoints ?? []).filter((k): k is string => typeof k === 'string' && k !== '')
  return (
    <>
      {description.title && <h3 className={shared.heading}>{description.title}</h3>}
      <Section title={t('photos.aiTranscription')}>
        {description.transcription ? (
          <div className={styles.transcription}>
            <Sanitized markdown={description.transcription} />
          </div>
        ) : (
          <p className={shared.hint}>{t('photos.aiNoText')}</p>
        )}
      </Section>
      {description.explanation && (
        <Section title={t('photos.aiExplanation')}>
          <p className={shared.body}>{description.explanation}</p>
        </Section>
      )}
      {points.length > 0 && (
        <Section title={t('photos.aiKeyPoints')}>
          <ul className={shared.bullets}>
            {keyedChoices(points).map(({ item, key }) => (
              <li key={key}>{item}</li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

/** A photo being read: what is written so far, in its places. */
export function PartialPhoto({ partial }: { partial: DeepPartial<PhotoDescription> | null }) {
  const t = useT()
  return (
    <div className={shared.stack}>
      <p className={shared.muted} role="status">
        {t('photos.aiReading')}
      </p>
      {partial?.title && (
        <div className={shared.stack} aria-busy="true">
          <Reading description={partial} />
        </div>
      )}
    </div>
  )
}
