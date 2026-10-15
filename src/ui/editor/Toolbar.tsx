import { Bold, Code, Heading, Italic, List, type LucideIcon, Redo2, Sigma, Undo2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../../i18n/react.tsx'
import { IconButton } from '../components/IconButton.tsx'
import styles from './MarkdownEditor.module.css'

export type Format = 'bold' | 'italic' | 'heading' | 'list' | 'math' | 'code'

const FORMATS: readonly [Format, LucideIcon, 'edBold' | 'edItalic' | 'edHeading' | 'edList' | 'edMath' | 'edCode'][] = [
  ['bold', Bold, 'edBold'],
  ['italic', Italic, 'edItalic'],
  ['heading', Heading, 'edHeading'],
  ['list', List, 'edList'],
  ['math', Sigma, 'edMath'],
  ['code', Code, 'edCode'],
]

export interface ToolbarProps {
  /** The raw Markdown is shown instead of the text as it reads. */
  source: boolean
  /**
   * The editor's controls; all absent while its code loads. The toolbar then holds the very place it will take
   * (same controls, same wrapping), so nothing below it moves when the editor arrives under a tap.
   */
  live?: {
    onSource: (source: boolean) => void
    onFormat: (format: Format) => void
    /** Undo and Redo, following the editor's history. */
    history: ReactNode
  }
}

/** The formatting toolbar of the Markdown editor, live or as the loading placeholder. */
export function Toolbar({ source, live }: ToolbarProps) {
  const t = useT()
  const idle = live === undefined
  return (
    <div
      className={styles.toolbar}
      role="toolbar"
      aria-label={t('common.edFormatting')}
      aria-hidden={idle || undefined}
      inert={idle}
    >
      <div className={styles.group}>
        {FORMATS.map(([format, icon, label]) => (
          <IconButton
            key={format}
            icon={icon}
            label={t(`common.${label}`)}
            disabled={idle}
            onClick={() => live?.onFormat(format)}
          />
        ))}
      </div>
      <span className={styles.spacer} />
      <button
        type="button"
        className={styles.mode}
        aria-pressed={source}
        aria-label={t('common.edSourceLabel')}
        disabled={idle}
        onClick={() => live?.onSource(!source)}
      >
        {t('common.edSource')}
      </button>
      <span className={styles.divider} aria-hidden="true" />
      {live ? (
        live.history
      ) : (
        <div className={styles.group}>
          <IconButton icon={Undo2} label={t('common.undo')} disabled />
          <IconButton icon={Redo2} label={t('common.redo')} disabled />
        </div>
      )}
    </div>
  )
}
