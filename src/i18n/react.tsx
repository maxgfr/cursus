import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react'
import { applyDocumentLocale, createTranslator, type Locale, type Translate } from './index.ts'

interface I18nValue {
  readonly locale: Locale
  readonly t: Translate
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ locale, children }: { readonly locale: Locale; readonly children: ReactNode }) {
  const value = useMemo<I18nValue>(() => ({ locale, t: createTranslator(locale) }), [locale])
  useEffect(() => applyDocumentLocale(locale), [locale])
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
