import { paths } from '../../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../../app/workspaceContext.tsx'
import type { Prefs } from '../../../core/contracts/workspace'
import { useT } from '../../../i18n/react.tsx'
import { Segmented } from '../../../ui/components/Segmented.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'

export default function GeneralSettings() {
  const t = useT()
  const ws = useWorkspace()
  const theme = useWorkspaceData(['prefs'], (w) => w.prefs.get('theme'))
  return (
    <Screen title={t('common.setGeneral')} back={paths.settings}>
      <Segmented<Prefs['theme']>
        label={t('settings.theme')}
        value={theme}
        onChange={(v) => ws.prefs.set('theme', v)}
        options={[
          { value: 'system', label: t('settings.themeSystem') },
          { value: 'light', label: t('settings.themeLight') },
          { value: 'dark', label: t('settings.themeDark') },
        ]}
      />
    </Screen>
  )
}
