import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { HashRouter, Routes } from './app/router.tsx'
import { isFocusRoute } from './app/routes.ts'
import { SaveBanner } from './app/SaveBanner.tsx'
import { SyncProvider } from './app/syncContext.tsx'
import { useRuntime, useWorkspaceData, WorkspaceProvider } from './app/workspaceContext.tsx'
import { detectFromEnvironment, UI_LOCALE_KEY } from './i18n/index.ts'
import { I18nProvider, useSetLocale, useT } from './i18n/react.tsx'
import UpdateToast from './screens/UpdateToast/index.tsx'
import { Button } from './ui/components/Button.tsx'
import { EmptyState } from './ui/components/EmptyState.tsx'
import { useStudy } from './ui/data/useStudy.ts'
import { Screen } from './ui/shell/Screen.tsx'
import { Shell } from './ui/shell/Shell.tsx'

// Not needed to paint Today: fetched right after it.
const Notices = lazy(() => import('./app/Notices.tsx'))

const isPaletteKey = (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k'

let paletteReady: (() => void) | null = null
const LazyPalette = lazy(() =>
  import('./ui/CommandPalette.tsx').then(({ CommandPalette }) => ({
    default: function ReadyPalette() {
      // Runs after the palette's own effects: its ⌘K listener is in place.
      useEffect(() => paletteReady?.(), [])
      return <CommandPalette />
    },
  })),
)

/**
 * ⌘K / Ctrl+K works from the first paint: a tiny listener holds a press made while the palette's code
 * is still loading, then replays it to the palette once it listens.
 */
function Palette() {
  const pressed = useRef<{ metaKey: boolean; ctrlKey: boolean } | null>(null)
  const ready = useRef(false)
  const onKey = useCallback((e: KeyboardEvent) => {
    if (ready.current || !isPaletteKey(e)) return
    e.preventDefault()
    pressed.current = { metaKey: e.metaKey, ctrlKey: e.ctrlKey }
  }, [])
  useEffect(() => {
    document.addEventListener('keydown', onKey)
    paletteReady = () => {
      ready.current = true
      document.removeEventListener('keydown', onKey)
      const p = pressed.current
      pressed.current = null
      if (p) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true, ...p }))
    }
    return () => {
      document.removeEventListener('keydown', onKey)
      paletteReady = null
    }
  }, [onKey])
  return (
    <Suspense fallback={null}>
      <LazyPalette />
    </Suspense>
  )
}

/** Applies the appearance preference; "system" leaves it to prefers-color-scheme. */
function ThemeSync() {
  const theme = useWorkspaceData(['prefs'], (ws) => ws.prefs.get('theme'))
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
  }, [theme])
  return null
}

/** Applies the language this device picked in Settings (device kv), before the app paints in another one. */
function LocaleBoot({ children }: { children: ReactNode }) {
  const rt = useRuntime()
  const setLocale = useSetLocale()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let live = true
    rt.store
      .read(['kv'], (tx) => tx.get<string>('kv', UI_LOCALE_KEY))
      .then((stored) => setLocale(detectFromEnvironment(stored ?? null)))
      .catch((e: unknown) => console.error('stored language unavailable', e))
      .finally(() => {
        if (live) setReady(true)
      })
    // Automatic mode follows a system language change live; a picked language stays put.
    const onLanguageChange = () => {
      rt.store
        .read(['kv'], (tx) => tx.get<string>('kv', UI_LOCALE_KEY))
        .then((stored) => (stored ? undefined : setLocale(detectFromEnvironment(null))))
        .catch((e: unknown) => console.error('language change not applied', e))
    }
    window.addEventListener('languagechange', onLanguageChange)
    return () => {
      live = false
      window.removeEventListener('languagechange', onLanguageChange)
    }
  }, [rt, setLocale])
  return ready ? children : null
}

function AppShell() {
  const [location] = useLocation()
  const { courses } = useStudy()
  return (
    <Shell focus={isFocusRoute(location)} courses={courses}>
      <Routes />
    </Shell>
  )
}

function Loading() {
  const t = useT()
  return (
    <main aria-busy="true">
      <p className="sr-only" role="status">
        {t('common.loading')}
      </p>
    </main>
  )
}

function BootFailed({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useT()
  return (
    <main>
      <Screen title={t('common.appName')}>
        <EmptyState
          title={t('common.bootError')}
          body={`${t('common.bootErrorHint')} (${error instanceof Error ? error.name : String(error)})`}
          action={
            <Button variant="primary" onClick={retry}>
              {t('common.retry')}
            </Button>
          }
        />
      </Screen>
    </main>
  )
}

export function App() {
  const locale = useMemo(() => detectFromEnvironment(), [])
  return (
    <I18nProvider locale={locale}>
      <HashRouter>
        <WorkspaceProvider loading={<Loading />} failed={(error, retry) => <BootFailed error={error} retry={retry} />}>
          <LocaleBoot>
            <SyncProvider>
              <ThemeSync />
              <AppShell />
              <SaveBanner />
              <Palette />
              {/* Separate boundaries: one chunk loading never holds back another. */}
              {/* Eager: storage persistence is asked for and the service worker registered at launch. */}
              <UpdateToast />
              <Suspense fallback={null}>
                <Notices />
              </Suspense>
            </SyncProvider>
          </LocaleBoot>
        </WorkspaceProvider>
      </HashRouter>
    </I18nProvider>
  )
}
