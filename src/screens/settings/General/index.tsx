import { useEffect, useState } from 'react'
import { paths } from '../../../app/routes.ts'
import { useRuntime, useWorkspace, useWorkspaceData } from '../../../app/workspaceContext.tsx'
import type { Prefs } from '../../../core/contracts/workspace'
import { type BaseLocale, detectFromEnvironment, isLocale, UI_LOCALE_KEY } from '../../../i18n/index.ts'
import { useSetLocale, useT } from '../../../i18n/react.tsx'
import { ListGroup, ListRow } from '../../../ui/components/List.tsx'
import { Segmented } from '../../../ui/components/Segmented.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'
import styles from '../Sync/settings.module.css'

type LanguageChoice = 'auto' | BaseLocale

/**
 * Appearance (written only when the user picks one), the interface language (this device only), and this
 * version of Cursus with its updates.
 */
export default function GeneralSettings() {
  const t = useT()
  const rt = useRuntime()
  const setLocale = useSetLocale()
  const ws = useWorkspace()
  const theme = useWorkspaceData(['prefs'], (w) => w.prefs.get('theme'))
  const [language, setLanguage] = useState<LanguageChoice | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    void rt.store
      .read(['kv'], (tx) => tx.get<string>('kv', UI_LOCALE_KEY))
      .then((stored) => {
        if (live) setLanguage(isLocale(stored) && stored !== 'pseudo' ? stored : 'auto')
      })
    return () => {
      live = false
    }
  }, [rt])

  const chooseLanguage = async (choice: LanguageChoice) => {
    setLanguage(choice)
    setFailed(false)
    try {
      // Device-local: a language belongs to this device and is never synced.
      await rt.store.commit([
        choice === 'auto' ? { delete: 'kv', key: UI_LOCALE_KEY } : { put: 'kv', key: UI_LOCALE_KEY, value: choice },
      ])
      await setLocale(choice === 'auto' ? detectFromEnvironment(null) : choice)
    } catch (e) {
      console.error('language switch failed', e)
      setFailed(true)
    }
  }

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
        {language !== null && (
          <Segmented<LanguageChoice>
            label={t('settings.language')}
            value={language}
            onChange={(v) => void chooseLanguage(v)}
            options={[
              { value: 'auto', label: t('settings.languageAutomatic') },
              { value: 'en', label: 'English', lang: 'en' },
              { value: 'de', label: 'Deutsch', lang: 'de' },
              { value: 'fr', label: 'Français', lang: 'fr' },
            ]}
          />
        )}
        {failed && (
          <p className={styles.bad} role="alert">
            {t('settings.languageFailed')}
          </p>
        )}
        <ListGroup title={t('settings.about')} footer={t('settings.languageHint')}>
          <ListRow title={t('settings.languageAuto')} trailing={<span translate="no">{navigator.language}</span>} />
        </ListGroup>
      </div>
    </Screen>
  )
}
