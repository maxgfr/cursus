import { useState } from 'react'
import { paths } from '../../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../../app/workspaceContext.tsx'
import { useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import styles from '../Sync/settings.module.css'

const RETENTION_MIN = 70
const RETENTION_MAX = 97

/** Daily new cards and target retention. Defaults stay in code: a pref is written only on Save, and only if changed. */
export default function ReviewPrefsSettings() {
  const t = useT()
  const ws = useWorkspace()
  const current = useWorkspaceData(['prefs'], (w) => ({
    dailyNewCards: w.prefs.get('dailyNewCards'),
    desiredRetention: w.prefs.get('desiredRetention'),
  }))
  const [daily, setDaily] = useState(String(current.dailyNewCards))
  const [retention, setRetention] = useState(String(Math.round(current.desiredRetention * 100)))
  const [saved, setSaved] = useState(false)

  const dailyN = Number(daily)
  const retentionN = Number(retention)
  const dailyOk = Number.isInteger(dailyN) && dailyN >= 0 && dailyN <= 9999
  const retentionOk = Number.isFinite(retentionN) && retentionN >= RETENTION_MIN && retentionN <= RETENTION_MAX
  const changed =
    dailyN !== current.dailyNewCards || Math.abs(retentionN / 100 - current.desiredRetention) > Number.EPSILON

  return (
    <Screen title={t('common.setReview')} back={paths.settings}>
      <form
        className={styles.stack}
        onSubmit={(e) => {
          e.preventDefault()
          if (!dailyOk || !retentionOk) return
          ws.batch(() => {
            if (dailyN !== current.dailyNewCards) ws.prefs.set('dailyNewCards', dailyN)
            const r = retentionN / 100
            if (Math.abs(r - current.desiredRetention) > Number.EPSILON) ws.prefs.set('desiredRetention', r)
          })
          setSaved(true)
        }}
      >
        <p className={styles.prose}>{t('common.reviewPrefsBody')}</p>
        <div className={styles.card}>
          <Field
            label={t('settings.dailyNew')}
            hint={t('settings.dailyNewHint')}
            type="number"
            inputMode="numeric"
            min={0}
            max={9999}
            step={1}
            value={daily}
            onChange={(e) => {
              setDaily(e.target.value)
              setSaved(false)
            }}
            error={dailyOk ? undefined : t('settings.dailyNewError')}
          />
          <Field
            label={t('settings.retentionPercent')}
            hint={t('settings.retentionHint')}
            type="number"
            inputMode="numeric"
            min={RETENTION_MIN}
            max={RETENTION_MAX}
            step={1}
            value={retention}
            onChange={(e) => {
              setRetention(e.target.value)
              setSaved(false)
            }}
            error={retentionOk ? undefined : t('settings.retentionError', { min: RETENTION_MIN, max: RETENTION_MAX })}
          />
        </div>
        {saved && (
          <p className={styles.ok} role="status">
            {t('settings.saved')}
          </p>
        )}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={!changed || !dailyOk || !retentionOk}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Screen>
  )
}
