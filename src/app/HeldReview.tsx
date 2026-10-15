import { useEffect, useState } from 'react'
import type { DeletionReport, GuardedKind } from '../core/model/deletions'
import type { HeldSegment } from '../core/sync/engine'
import { formatDateTime } from '../i18n/format.ts'
import { useLocale, useT } from '../i18n/react.tsx'
import { noteError } from '../screens/settings/Diagnostic/recent.ts'
import { Banner } from '../ui/components/Banner.tsx'
import { Button } from '../ui/components/Button.tsx'
import { Sheet } from '../ui/components/Sheet.tsx'
import { useGuard } from '../ui/PasswordGate.tsx'
import styles from './HeldReview.module.css'
import { useSync } from './syncContext.tsx'
import { useRuntime } from './workspaceContext.tsx'

/** Titles listed in the review; the rest is counted. */
const MAX_TITLES = 10

const COUNT_KEYS = {
  courses: 'sync.heldCourses',
  sections: 'sync.heldSections',
  sources: 'sync.heldSources',
  fiches: 'sync.heldSheets',
  cards: 'sync.heldCards',
  texts: 'sync.heldTexts',
} as const satisfies Record<GuardedKind | 'texts', string>

interface Held {
  segments: HeldSegment[]
  report: DeletionReport
}

/**
 * The sync guard held back segments from another device that would delete much of the library here: a banner on
 * every screen, and a review sheet where the user keeps their data (applied, then restored forward, so the other
 * devices get it back) or applies the deletions (behind the device password, when one is set).
 */
export default function HeldReview() {
  const t = useT()
  const locale = useLocale()
  const rt = useRuntime()
  const { engine, scheduler, status } = useSync()
  const { guard, sheet: guardSheet } = useGuard()
  const [held, setHeld] = useState<Held | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'keep' | 'apply' | null>(null)
  const [failed, setFailed] = useState(false)
  const count = status?.held ?? 0

  useEffect(() => {
    if (!engine || count === 0) {
      setHeld(null)
      return
    }
    let live = true
    engine.held().then(
      (segments) => {
        if (live) setHeld({ segments, report: rt.ws.previewRemote(segments.map((s) => s.update)) })
      },
      (e: unknown) => noteError('sync.held', e),
    )
    return () => {
      live = false
    }
  }, [engine, count, rt])

  if (!held || held.segments.length === 0 || !engine) return null

  const devices = [...new Set(held.segments.map((s) => s.deviceId))]
  const device =
    devices.length === 1
      ? t('sync.heldDevice', { id: (devices[0] ?? '').slice(-4) })
      : t('sync.heldDevices', { count: devices.length })
  const when = formatDateTime(locale, Math.min(...held.segments.map((s) => s.heldAt)))
  const { report } = held
  const shown = report.entities.slice(0, MAX_TITLES)
  const more = report.entities.length - shown.length

  const decide = async (mode: 'keep' | 'apply') => {
    setBusy(mode)
    setFailed(false)
    try {
      // What is held now, not what the sheet was opened on: one more segment may have been held since.
      const segments = await engine.held()
      rt.ws.absorbHeld(
        segments.map((s) => s.update),
        mode,
      )
      await engine.release(segments.map((s) => s.key))
      setOpen(false)
      // The restoration (keep) goes out at once.
      await rt.seal()
      scheduler?.trigger('manual')
    } catch (e) {
      noteError('sync.release', e)
      setFailed(true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Banner
        title={t('sync.heldTitle')}
        body={t('sync.heldBody', { count: report.total, device, when })}
        action={
          <Button variant="primary" onClick={() => setOpen(true)}>
            {t('sync.heldReview')}
          </Button>
        }
      />
      <Sheet open={open} title={t('sync.heldSheetTitle')} onClose={() => setOpen(false)}>
        <div className={styles.review} data-testid="held-review">
          <p>{t('sync.heldSheetIntro', { device, when })}</p>
          <ul className={styles.counts}>
            {(Object.keys(COUNT_KEYS) as (keyof typeof COUNT_KEYS)[])
              .filter((k) => report.counts[k] > 0)
              .map((k) => (
                <li key={k}>{t(COUNT_KEYS[k], { count: report.counts[k] })}</li>
              ))}
          </ul>
          {shown.length > 0 && (
            <ul className={styles.titles}>
              {shown.map((e) => (
                <li key={`${e.kind}/${e.id}`}>{e.title || t('sync.heldUntitled')}</li>
              ))}
              {more > 0 && <li>{t('sync.heldMore', { count: more })}</li>}
            </ul>
          )}
          {failed && (
            <p className={styles.bad} role="alert">
              {t('sync.heldFailed')}
            </p>
          )}
          <Button
            variant="primary"
            size="large"
            full
            loading={busy === 'keep'}
            disabled={busy !== null}
            onClick={() => void decide('keep')}
          >
            {t('sync.heldKeep')}
          </Button>
          <p className={styles.note}>{t('sync.heldKeepHint')}</p>
          <Button
            variant="danger"
            full
            loading={busy === 'apply'}
            disabled={busy !== null}
            onClick={() => guard(() => decide('apply'))}
          >
            {t('sync.heldApply')}
          </Button>
          <p className={styles.note}>{t('sync.heldApplyHint')}</p>
        </div>
      </Sheet>
      {guardSheet}
    </>
  )
}
