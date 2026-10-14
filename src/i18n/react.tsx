import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  applyDocumentLocale,
  createTranslator,
  type Locale,
  loadCatalog,
  loadedCatalog,
  type Translate,
} from './index.ts'

interface I18nValue {
  readonly locale: Locale
  readonly t: Translate
}

const I18nContext = createContext<I18nValue | null>(null)

/** Switches the interface language in place; resolves once the new catalog is applied. */
type SetLocale = (locale: Locale) => Promise<void>

const SetLocaleContext = createContext<SetLocale | null>(null)

/**
 * Provides the translator of `locale` (the initial one; `useSetLocale` changes it in place). A catalog is
 * fetched before it applies: nothing renders until the first one is there, and on a switch the previous
 * language stays on screen until the next one arrives (the tree is never unmounted).
 */
export function I18nProvider({ locale, children }: { readonly locale: Locale; readonly children: ReactNode }) {
  const [value, setValue] = useState<I18nValue | null>(() =>
    loadedCatalog(locale) === undefined ? null : { locale, t: createTranslator(locale) },
  )
  const [failure, setFailure] = useState<unknown>(null)
  const latest = useRef(locale)
  const setLocale = useCallback<SetLocale>(async (next) => {
    latest.current = next
    await loadCatalog(next)
    if (latest.current === next) setValue({ locale: next, t: createTranslator(next) })
  }, [])
  useEffect(() => {
    // A catalog that cannot be fetched (offline before it was ever cached) is a boot failure.
    setLocale(locale).catch((e: unknown) => setFailure(e))
  }, [locale, setLocale])
  const current = value?.locale
  useEffect(() => {
    if (current !== undefined) applyDocumentLocale(current)
  }, [current])
  if (failure !== null) throw failure
  if (value === null) return null
  return (
    <SetLocaleContext.Provider value={setLocale}>
      <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
    </SetLocaleContext.Provider>
  )
}

export function useSetLocale(): SetLocale {
  const value = useContext(SetLocaleContext)
  if (value === null) throw new Error('useSetLocale must be used inside <I18nProvider>')
  return value
}

function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (value === null) throw new Error('useT must be used inside <I18nProvider>')
  return value
}

export function useT(): Translate {
  return useI18n().t
}

export function useLocale(): Locale {
  return useI18n().locale
}
