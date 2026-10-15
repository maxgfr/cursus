import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { GUARD_MIN_LENGTH } from '../../../core/storage/guard'
import { useT } from '../../../i18n/react.tsx'
import { Button } from '../../../ui/components/Button.tsx'
import { Field } from '../../../ui/components/Field.tsx'
import { useGuardStore } from '../../../ui/PasswordGate.tsx'
import { noteError } from '../Diagnostic/recent.ts'
import styles from '../Sync/settings.module.css'

type Mode = 'set' | 'change' | 'remove' | null

/** « Protect destructive actions »: a device-only password; a lock against accidents, not encryption. */
export function GuardSection() {
  const t = useT()
  const store = useGuardStore()
  const [isSet, setIsSet] = useState<boolean | null>(null)
  const [mode, setMode] = useState<Mode>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [tried, setTried] = useState(false)
  const [wrong, setWrong] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => setIsSet(await store.isSet()), [store])
  useEffect(() => {
    refresh().catch((e: unknown) => noteError('guard.load', e))
  }, [refresh])

  const begin = (m: Mode) => {
    setMode(m)
    setCurrent('')
    setNext('')
    setAgain('')
    setTried(false)
    setWrong(false)
    setFailed(false)
    setMessage(null)
  }

  const needsNew = mode === 'set' || mode === 'change'
  const tooShort = needsNew && next.length < GUARD_MIN_LENGTH
  const mismatch = needsNew && next !== again

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (tooShort || mismatch) return
    setSaving(true)
    setFailed(false)
    try {
      let ok = true
      if (mode === 'set') await store.set(next)
      else if (mode === 'change') ok = await store.change(current, next)
      else if (mode === 'remove') ok = await store.remove(current)
      if (!ok) {
        setWrong(true)
        return
      }
      const done = mode === 'remove' ? t('settings.guardRemoved') : t('settings.guardSaved')
      begin(null)
      setMessage(done)
      await refresh()
    } catch (err) {
      noteError('guard.save', err)
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={styles.card} aria-labelledby="data-guard">
      <h2 id="data-guard" className={styles.sectionTitle}>
        {t('settings.guardTitle')}
      </h2>
      <p className={styles.prose}>{t('settings.guardBody')}</p>
      <p className={styles.note}>{t('settings.guardNotEncryption', { name: t('sync.sealTitle') })}</p>
      {isSet !== null && (
        <p className={isSet ? styles.ok : styles.note}>{isSet ? t('settings.guardOn') : t('settings.guardOff')}</p>
      )}
      {message && (
        <p className={styles.ok} role="status">
          {message}
        </p>
      )}
      {mode === null ? (
        isSet !== null && (
          <div className={styles.actions}>
            {isSet ? (
              <>
                <Button onClick={() => begin('change')}>{t('settings.guardChange')}</Button>
                <Button variant="danger" onClick={() => begin('remove')}>
                  {t('settings.guardRemove')}
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => begin('set')}>
                {t('settings.guardSet')}
              </Button>
            )}
          </div>
        )
      ) : (
        <form className={styles.stack} onSubmit={(e) => void submit(e)}>
          {mode !== 'set' && (
            <Field
              label={t('settings.guardCurrent')}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value)
                setWrong(false)
              }}
              error={wrong ? t('settings.guardWrong') : undefined}
            />
          )}
          {needsNew && (
            <>
              <Field
                label={t('settings.guardNew')}
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                error={tried && tooShort ? t('settings.guardTooShort', { count: GUARD_MIN_LENGTH }) : undefined}
              />
              <Field
                label={t('settings.guardAgain')}
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                error={tried && !tooShort && mismatch ? t('settings.guardMismatch') : undefined}
              />
            </>
          )}
          {failed && (
            <p className={styles.bad} role="alert">
              {t('errors.generic')}
            </p>
          )}
          <div className={styles.actions}>
            <Button
              type="submit"
              variant={mode === 'remove' ? 'danger' : 'primary'}
              loading={saving}
              disabled={mode !== 'set' && current.length === 0}
            >
              {mode === 'remove' ? t('settings.guardRemove') : t('settings.guardSave')}
            </Button>
            <Button variant="plain" onClick={() => begin(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
