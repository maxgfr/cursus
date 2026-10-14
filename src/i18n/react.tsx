import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import {
  applyDocumentLocale,
  type Catalog,
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

/**
 * Provides the translator of `locale`. English is bundled; another locale's catalog is fetched first
 * (nothing renders until it is there, which is one small request on that device's first paint).
 */
export function I18nProvider({ locale, children }: { readonly locale: Locale; readonly children: ReactNode }) {
  const [catalog, setCatalog] = useState<Catalog | undefined>(() => loadedCatalog(locale))
  const [failure, setFailure] = useState<unknown>(null)
  useEffect(() => {
    let live = true
    setCatalog(loadedCatalog(locale))
    loadCatalog(locale).then(
      (c) => {
        if (live) setCatalog(c)
      },
      (e: unknown) => {
        if (live) setFailure(e)
      },
    )
    return () => {
      live = false
    }
  }, [locale])
  const value = useMemo<I18nValue | null>(
    // `catalog` may still be the previous locale's for one render: wait for this one's.
    () =>
      catalog === undefined || loadedCatalog(locale) === undefined ? null : { locale, t: createTranslator(locale) },
    [locale, catalog],
  )
  useEffect(() => applyDocumentLocale(locale), [locale])
  // A catalog that cannot be fetched (offline before it was ever cached) is a boot failure.
  if (failure !== null) throw failure
  if (value === null) return null
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
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
