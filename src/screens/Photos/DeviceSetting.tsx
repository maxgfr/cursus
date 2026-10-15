import { useEffect, useId, useState } from 'react'
import { useSync } from '../../app/syncContext.tsx'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { type PhotoMode, readPhotoMode, writePhotoMode } from '../../core/content/photos'
import { useT } from '../../i18n/react.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { noteError } from '../settings/Diagnostic/recent.ts'
import styles from '../settings/Sync/settings.module.css'

/**
 * "Photos on this device: all / on demand". A device setting (never synced): on demand, photos stay listed and
 * download when opened; switching back to all fetches the missing ones at the next sync round. Nothing is ever
 * removed from a destination either way.
 */
export function PhotoDeviceSetting() {
  const t = useT()
  const rt = useRuntime()
  const { scheduler } = useSync()
  const id = useId()
  const [mode, setMode] = useState<PhotoMode | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    readPhotoMode(rt.store).then(
      (m) => {
        if (live) setMode(m)
      },
      (e: unknown) => {
        noteError('photos.mode', e)
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [rt])

  const change = (next: PhotoMode) => {
    const before = mode
    setMode(next)
    setFailed(false)
    writePhotoMode(rt.store, next).then(
      () => {
        if (next === 'all') scheduler?.trigger('manual')
      },
      (e: unknown) => {
        noteError('photos.mode', e)
        setMode(before)
        setFailed(true)
      },
    )
  }

  return (
    <section className={styles.card} aria-labelledby={id} data-testid="photo-mode">
      <h2 id={id} className={styles.sectionTitle}>
        {t('photos.deviceTitle')}
      </h2>
      {mode !== null && (
        <Segmented<PhotoMode>
          label={t('photos.deviceTitle')}
          hideLabel
          value={mode}
          onChange={change}
          options={[
            { value: 'all', label: t('photos.deviceAll') },
            { value: 'on-demand', label: t('photos.deviceOnDemand') },
          ]}
        />
      )}
      <p className={styles.note}>{mode === 'on-demand' ? t('photos.deviceOnDemandHint') : t('photos.deviceAllHint')}</p>
      {failed && (
        <p className={styles.bad} role="alert">
          {t('photos.actionFailed')}
        </p>
      )}
    </section>
  )
}
