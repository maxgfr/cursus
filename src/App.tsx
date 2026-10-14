import { useEffect, useMemo } from 'react'
import { useLocation } from 'wouter'
import { HashRouter, Routes } from './app/router.tsx'
import { isFocusRoute } from './app/routes.ts'
import { SaveBanner } from './app/SaveBanner.tsx'
import { SyncProvider } from './app/syncContext.tsx'
import { useWorkspaceData, WorkspaceProvider } from './app/workspaceContext.tsx'
import { detectFromEnvironment } from './i18n/index.ts'
import { I18nProvider, useT } from './i18n/react.tsx'
import UpdateToast from './screens/UpdateToast/index.tsx'
import { Button } from './ui/components/Button.tsx'
import { EmptyState } from './ui/components/EmptyState.tsx'
import { useStudy } from './ui/data/useStudy.ts'
import { Screen } from './ui/shell/Screen.tsx'
import { Shell } from './ui/shell/Shell.tsx'

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
          <SyncProvider>
            <ThemeSync />
            <AppShell />
            <SaveBanner />
            <UpdateToast />
          </SyncProvider>
        </WorkspaceProvider>
      </HashRouter>
    </I18nProvider>
  )
}
