import { Trash2 } from 'lucide-react'
import { type FormEvent, type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { useRuntime } from '../app/workspaceContext.tsx'
import { type Guard, guardOf } from '../core/storage/guard'
import { useT } from '../i18n/react.tsx'
import { eraseThisDevice } from '../screens/settings/Data/erase.ts'
import { noteError } from '../screens/settings/Diagnostic/recent.ts'
import styles from '../screens/settings/Sync/settings.module.css'
import { Button } from './components/Button.tsx'
import { Field } from './components/Field.tsx'
import { Sheet } from './components/Sheet.tsx'

type Run = () => void | Promise<void>
type Mode = 'ask' | 'forgot'
type Erase = 'idle' | 'erasing' | 'blocked' | 'failed'

/** The device password store (`kv`), kept on this device only. */
export function useGuardStore(): Guard {
  const rt = useRuntime()
  return useMemo(() => guardOf(rt.store, rt.rng), [rt.store, rt.rng])
}

/**
 * Asks for the device password before a destructive action, only when one is set. Returns `guard(run)` and the
 * prompt sheet, which the caller renders. A wrong password shows an error; the right one runs the action.
 */
export function useGuard(): { guard: (run: Run) => void; sheet: ReactNode } {
  const t = useT()
  const rt = useRuntime()
  const store = useGuardStore()
  const pending = useRef<Run | null>(null)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('ask')
  const [pass, setPass] = useState('')
  const [wrong, setWrong] = useState(false)
  const [checking, setChecking] = useState(false)
  const [word, setWord] = useState('')
  const [erase, setErase] = useState<Erase>('idle')

  const perform = useCallback((run: Run) => {
    Promise.resolve()
      .then(run)
      .catch((e: unknown) => noteError('guard.run', e))
  }, [])

  const guard = useCallback(
    (run: Run) => {
      store
        .isSet()
        .then((set) => {
          if (!set) return perform(run)
          pending.current = run
          setMode('ask')
          setPass('')
          setWrong(false)
          setWord('')
          setErase('idle')
          setOpen(true)
        })
        .catch((e: unknown) => noteError('guard.check', e))
    },
    [store, perform],
  )

  const close = () => {
    if (checking || erase === 'erasing' || erase === 'blocked') return
    pending.current = null
    setOpen(false)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (pass.length === 0) return
    setChecking(true)
    try {
      const ok = await store.verify(pass)
      if (!ok) {
        setWrong(true)
        return
      }
      const run = pending.current
      pending.current = null
      setOpen(false)
      if (run) perform(run)
    } finally {
      setChecking(false)
    }
  }

  const eraseAll = async () => {
    setErase('erasing')
    try {
      await eraseThisDevice({ close: () => rt.store.close(), onBlocked: () => setErase('blocked') })
    } catch (err) {
      noteError('guard.erase', err)
      setErase('failed')
      return
    }
    location.replace(import.meta.env.BASE_URL)
  }

  const confirmWord = t('settings.guardWord')
  const sheet = (
    <Sheet
      open={open}
      title={mode === 'ask' ? t('settings.guardPromptTitle') : t('settings.guardForgot')}
      onClose={close}
    >
      {mode === 'ask' ? (
        <form className={styles.stack} onSubmit={(e) => void submit(e)}>
          <p className={styles.prose}>{t('settings.guardPromptBody')}</p>
          <Field
            label={t('settings.guardPassword')}
            type="password"
            autoComplete="current-password"
            value={pass}
            onChange={(e) => {
              setPass(e.target.value)
              setWrong(false)
            }}
            error={wrong ? t('settings.guardWrong') : undefined}
          />
          <div className={styles.actions}>
            <Button type="submit" variant="primary" loading={checking} disabled={pass.length === 0}>
              {t('settings.guardContinue')}
            </Button>
            <Button variant="plain" onClick={() => setMode('forgot')}>
              {t('settings.guardForgot')}
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.stack}>
          <p className={styles.prose}>{t('settings.guardForgotBody')}</p>
          <Field
            label={t('settings.guardForgotType', { word: confirmWord })}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={word}
            onChange={(e) => setWord(e.target.value)}
          />
          {erase === 'blocked' && (
            <p className={styles.warn} role="alert">
              {t('settings.eraseBlocked')}
            </p>
          )}
          {erase === 'failed' && (
            <p className={styles.bad} role="alert">
              {t('settings.eraseFailed')}
            </p>
          )}
          <div className={styles.actions}>
            <Button
              variant="danger"
              icon={<Trash2 size={18} aria-hidden="true" />}
              disabled={word.trim() !== confirmWord || erase === 'failed'}
              loading={erase === 'erasing' || erase === 'blocked'}
              onClick={() => void eraseAll()}
            >
              {t('settings.eraseConfirm')}
            </Button>
            <Button variant="plain" onClick={() => setMode('ask')}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  )
  return { guard, sheet }
}
