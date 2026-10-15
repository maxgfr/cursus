import {
  CalendarCheck,
  Cloud,
  Database,
  FileText,
  Info,
  LifeBuoy,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useEffect } from 'react'
import { paths } from '../../app/routes.ts'
import { useSync } from '../../app/syncContext.tsx'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { SyncBadge } from '../../ui/components/Badges.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { restoreDestinations } from '../settings/Sync/registry.ts'

const ICON = 20

export default function Settings() {
  const t = useT()
  const rt = useRuntime()
  const { summary, engine, scheduler } = useSync()
  // Remembered destinations rejoin the engine as soon as settings open.
  useEffect(() => {
    if (engine && scheduler) void restoreDestinations(rt, engine, scheduler)
  }, [rt, engine, scheduler])
  return (
    <Screen title={t('settings.title')}>
      <ListGroup title={t('settings.groupSafe')}>
        <ListRow
          href={paths.settingsSync}
          leading={<Cloud size={ICON} />}
          title={t('settings.sync')}
          trailing={<SyncBadge summary={summary} />}
        />
        <ListRow href={paths.settingsPair} leading={<Smartphone size={ICON} />} title={t('sync.pairDevice')} />
        <ListRow href={paths.settingsSeal} leading={<ShieldCheck size={ICON} />} title={t('common.setSeal')} />
        <ListRow href={paths.settingsRecovery} leading={<LifeBuoy size={ICON} />} title={t('common.setRecovery')} />
      </ListGroup>
      <ListGroup title={t('settings.groupPrefs')}>
        <ListRow
          href={paths.settingsGeneral}
          leading={<SlidersHorizontal size={ICON} />}
          title={t('common.setGeneral')}
        />
        <ListRow href={paths.settingsReview} leading={<CalendarCheck size={ICON} />} title={t('common.setReview')} />
        <ListRow href={paths.settingsAi} leading={<Sparkles size={ICON} />} title={t('common.setAi')} />
      </ListGroup>
      <ListGroup title={t('settings.groupData')}>
        <ListRow href={paths.settingsData} leading={<Database size={ICON} />} title={t('common.setData')} />
        <ListRow href={paths.trash} leading={<Trash2 size={ICON} />} title={t('common.trashTitle')} />
      </ListGroup>
      <ListGroup title={t('settings.groupHelp')}>
        <ListRow href={paths.onboarding} leading={<Info size={ICON} />} title={t('common.welcomeTitle')} />
        <ListRow href={paths.settingsDiagnostic} leading={<FileText size={ICON} />} title={t('common.setDiagnostic')} />
      </ListGroup>
    </Screen>
  )
}
