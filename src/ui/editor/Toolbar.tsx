import { Bold, Code, Heading, Italic, List, type LucideIcon, Redo2, Sigma, Undo2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../../i18n/react.tsx'
import { IconButton } from '../components/IconButton.tsx'
import styles from './MarkdownEditor.module.css'

export type EditorMode = 'write' | 'preview'
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
  mode: EditorMode
  /**
   * The editor's controls; all absent while its code loads. The toolbar then holds the very place it will take
   * (same controls, same wrapping), so nothing below it moves when the editor arrives under a tap.
   */
  live?: {
    onMode: (mode: EditorMode) => void
    onFormat: (format: Format) => void
    /** Undo and Redo, following the editor's history. */
    history: ReactNode
  }
}

/** The formatting toolbar of the Markdown editor, live or as the loading placeholder. */
export function Toolbar({ mode, live }: ToolbarProps) {
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
        {(['write', 'preview'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={styles.mode}
            aria-pressed={mode === m}
            disabled={idle}
            onClick={() => live?.onMode(m)}
          >
            {m === 'write' ? t('common.edWrite') : t('common.edPreview')}
          </button>
        ))}
      </div>
      {mode === 'write' && (
        <>
          <span className={styles.divider} aria-hidden="true" />
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
          {live ? (
            live.history
          ) : (
            <div className={styles.group}>
              <IconButton icon={Undo2} label={t('common.undo')} disabled />
              <IconButton icon={Redo2} label={t('common.redo')} disabled />
            </div>
          )}
        </>
      )}
    </div>
  )
}
