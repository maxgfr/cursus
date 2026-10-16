import { RotateCcw, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRuntime } from '../../app/workspaceContext.tsx'
import type { CardImprovement } from '../../core/ai/schemas'
import type { Id } from '../../core/contracts/workspace'
import { useT } from '../../i18n/react.tsx'
import { chunkLoader } from '../../ui/chat/studyRun.ts'
import { Button } from '../../ui/components/Button.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { usePartial } from '../../ui/data/usePartial.ts'
import { Sanitized } from '../../ui/render/Sanitized.tsx'
import shared from '../Understand/shared/ai.module.css'
import { useAiModel } from '../Understand/shared/aiConfig.ts'
import { improveRun } from './assistRun.ts'
import { describeFailure } from './failure.ts'
import { replaceFaces } from './replaceFaces.ts'

/** The card's texts before a rewrite was used: « Undo » puts them back. */
export interface Rewritten {
  cardId: Id
  front: string
  back: string
}

/**
 * « Improve » a card: a rewrite written as it comes (atomic, unambiguous, same meaning and kind), then « Use this
 * version » replaces both faces at once; `onUsed` gets what they were, for one « Undo ». Before the card's answer
 * shows, the proposed answer waits folded. Asked again with « Rewrite again ».
 */
export function ImproveSheet({
  cardId,
  revealed,
  onClose,
  onUsed,
}: {
  cardId: Id | null
  revealed: boolean
  onClose: () => void
  onUsed: (before: Rewritten) => void
}) {
  const t = useT()
  return (
    <Sheet open={cardId !== null} title={t('review.improveTitle')} onClose={onClose}>
      {cardId !== null && <Improver cardId={cardId} revealed={revealed} onClose={onClose} onUsed={onUsed} />}
    </Sheet>
  )
}

function Improver({
  cardId,
  revealed,
  onClose,
  onUsed,
}: {
  cardId: Id
  revealed: boolean
  onClose: () => void
  onUsed: (before: Rewritten) => void
}) {
  const t = useT()
  const rt = useRuntime()
  const ai = useAiModel()
  const stream = usePartial<CardImprovement>()
  const [value, setValue] = useState<CardImprovement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const load = useMemo(() => chunkLoader(rt.ws, rt), [rt])
  const ready = ai.status === 'ready' ? ai : null
  const { reset, onPartial } = stream

  // Asked when the sheet opens, and again on « Rewrite again »; leaving stops it.
  const ask = useCallback(() => {
    if (!ready) return
    const record = rt.ws.cards.get(cardId)
    if (!record) return
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setValue(null)
    setError(null)
    reset()
    const card = {
      front: rt.ws.text({ id: cardId, field: 'front' }).toString(),
      back: rt.ws.text({ id: cardId, field: 'back' }).toString(),
      kind: record.kind,
    }
    improveRun({ ws: rt.ws, ai: ready, load }, card, record.courseId, ctl.signal, onPartial).then(
      (v) => {
        if (ctl.signal.aborted) return
        reset()
        setValue(v)
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return
        console.warn('rewrite failed', e)
        setError(t('chat.failed', { reason: describeFailure(e, t) }))
      },
    )
  }, [cardId, ready, rt, load, reset, onPartial, t])
  useEffect(() => {
    ask()
    return () => abort.current?.abort()
  }, [ask])

  const use = () => {
    if (!value) return
    const before: Rewritten = {
      cardId,
      front: rt.ws.text({ id: cardId, field: 'front' }).toString(),
      back: rt.ws.text({ id: cardId, field: 'back' }).toString(),
    }
    replaceFaces(rt.ws, cardId, value.front, value.back)
    onUsed(before)
    onClose()
  }

  const shown = value ?? stream.partial
  const busy = value === null && error === null
  return (
    <div className={shared.stack} aria-busy={busy || undefined}>
      {!shown?.front && busy && (
        <p className={shared.muted} role="status">
          {t('review.improving')}
        </p>
      )}
      {shown?.front && (
        <div className={shared.tight}>
          <span className={shared.label}>{t('review.question')}</span>
          <Sanitized markdown={shown.front} />
        </div>
      )}
      {shown?.back !== undefined &&
        (revealed ? (
          <div className={shared.tight}>
            <span className={shared.label}>{t('review.answer')}</span>
            <Sanitized markdown={shown.back} />
          </div>
        ) : (
          <details className={shared.disclosure}>
            <summary className={shared.disclosureSummary}>
              <span className={shared.disclosureLabel}>{t('chat.showProposedAnswer')}</span>
            </summary>
            <div className={shared.disclosureBody}>
              <Sanitized markdown={shown.back} />
            </div>
          </details>
        ))}
      {value?.rationale && <p className={shared.muted}>{value.rationale}</p>}
      {error && (
        <p className={shared.error} role="alert">
          {error}
        </p>
      )}
      <div className={shared.row}>
        <Button variant="primary" icon={<Wand2 size={18} aria-hidden="true" />} disabled={!value} onClick={use}>
          {t('review.applyImprovement')}
        </Button>
        <Button variant="plain" icon={<RotateCcw size={18} aria-hidden="true" />} disabled={busy} onClick={ask}>
          {t('review.improveAgain')}
        </Button>
      </div>
    </div>
  )
}
