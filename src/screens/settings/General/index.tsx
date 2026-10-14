import { paths } from '../../../app/routes.ts'
import { useWorkspace, useWorkspaceData } from '../../../app/workspaceContext.tsx'
import type { Prefs } from '../../../core/contracts/workspace'
import { useLocale, useT } from '../../../i18n/react.tsx'
import { ListGroup, ListRow } from '../../../ui/components/List.tsx'
import { Segmented } from '../../../ui/components/Segmented.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import styles from '../Sync/settings.module.css'

const LANGUAGE_NAME: Record<string, string> = { en: 'English', de: 'Deutsch', fr: 'Français', pseudo: 'Pseudo' }

/** Appearance (written only when the user picks one) and what this device runs. */
export default function GeneralSettings() {
  const t = useT()
  const locale = useLocale()
  const ws = useWorkspace()
  const theme = useWorkspaceData(['prefs'], (w) => w.prefs.get('theme'))
  return (
    <Screen title={t('common.setGeneral')} back={paths.settings}>
      <div className={styles.stack}>
        <Segmented<Prefs['theme']>
          label={t('settings.theme')}
          value={theme}
          onChange={(v) => {
            if (v !== theme) ws.prefs.set('theme', v)
          }}
          options={[
            { value: 'system', label: t('settings.themeSystem') },
            { value: 'light', label: t('settings.themeLight') },
            { value: 'dark', label: t('settings.themeDark') },
          ]}
        />
        <ListGroup title={t('settings.about')} footer={t('settings.languageHint')}>
          <ListRow title={t('settings.language')} trailing={LANGUAGE_NAME[locale] ?? locale} />
          <ListRow title={t('settings.languageAuto')} trailing={navigator.language} />
        </ListGroup>
      </div>
    </Screen>
  )
}
