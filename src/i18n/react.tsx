import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { guardChunk } from '../app/chunkGuard.ts'
import { noteError } from '../screens/settings/Diagnostic/recent.ts'
import { Button } from '../ui/components/Button.tsx'
import { EmptyState } from '../ui/components/EmptyState.tsx'
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
    // A catalog that cannot be fetched (offline before it was ever cached) is a boot failure; one aborted by a
    // navigation away is not (the guard holds it until the page is back, should it come back).
    guardChunk(() => setLocale(locale), 'i18n.catalog', noteError).catch((e: unknown) => setFailure(e))
  }, [locale, setLocale])
  // Keyed on the value, not the locale: a device region change re-applies the regional <html lang>.
  useEffect(() => {
    if (value !== null) applyDocumentLocale(value.locale)
  }, [value])
  if (failure !== null) return <CatalogFailed />
  if (value === null) return null
  return (
    <SetLocaleContext.Provider value={setLocale}>
      <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
    </SetLocaleContext.Provider>
  )
}

/** Without a catalog there is no translated text: the few words needed, in the device's language. */
const noCatalog = {
  en: ['Cursus didn’t load.', 'Your data is safe. Check the connection, then reload.', 'Reload'],
  de: ['Cursus wurde nicht geladen.', 'Deine Daten sind sicher. Prüfe die Verbindung und lade neu.', 'Neu laden'],
  fr: ['Cursus ne s’est pas chargé.', 'Vos données sont intactes. Vérifiez la connexion, puis rechargez.', 'Recharger'],
} as const

function CatalogFailed() {
  const lang = navigator.language.slice(0, 2)
  const [title, body, reload] = lang === 'de' || lang === 'fr' ? noCatalog[lang] : noCatalog.en
  return (
    <main>
      <EmptyState
        title={title}
        body={body}
        action={
          <Button variant="primary" onClick={() => location.reload()}>
            {reload}
          </Button>
        }
      />
    </main>
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
