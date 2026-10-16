import { useEffect, useId, useState } from 'react'
import { useRuntime, useWorkspace, useWorkspaceData } from '../../app/workspaceContext.tsx'
import type { Prefs } from '../../core/contracts/workspace'
import { type BaseLocale, detectFromEnvironment, isLocale, UI_LOCALE_KEY } from '../../i18n/index.ts'
import { useSetLocale, useT } from '../../i18n/react.tsx'
import list from '../../ui/components/List.module.css'
import { Segmented } from '../../ui/components/Segmented.tsx'
import settings from '../settings/Sync/settings.module.css'

type LanguageChoice = 'auto' | BaseLocale

/**
 * The first group of the settings: the appearance (written only when the student picks one) and the interface
 * language (this device only, applied in place).
 */
export function Appearance() {
  const t = useT()
  const rt = useRuntime()
  const setLocale = useSetLocale()
  const ws = useWorkspace()
  const titleId = useId()
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
    <section className={list.group} aria-labelledby={titleId}>
      <h2 id={titleId} className={list.groupTitle}>
        {t('settings.groupAppearance')}
      </h2>
      <div className={settings.card}>
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
          <p className={settings.bad} role="alert">
            {t('settings.languageFailed')}
          </p>
        )}
      </div>
      <p className={list.footer}>
        {t('settings.languageHint')} {t('settings.languageAuto')}: <span translate="no">{navigator.language}</span>
      </p>
    </section>
  )
}
