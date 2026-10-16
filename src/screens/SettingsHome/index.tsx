import { CalendarCheck, Cloud, Database, FileText, Info, LockKeyhole, Smartphone, Sparkles, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import { paths } from '../../app/routes.ts'
import { useSync } from '../../app/syncContext.tsx'
import { useRuntime } from '../../app/workspaceContext.tsx'
import { useT } from '../../i18n/react.tsx'
import { useAiShown } from '../../ui/ai/ready.ts'
import { SyncBadge } from '../../ui/components/Badges.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { restoreDestinations } from '../settings/Sync/registry.ts'
import { Appearance } from './Appearance.tsx'

const ICON = 20

/**
 * The settings, most used first: how the app looks and speaks, studying, then backups and devices, the data and its
 * safety, and help.
 */
export default function Settings() {
  const t = useT()
  const rt = useRuntime()
  const { summary, status, engine, scheduler } = useSync()
  const aiShown = useAiShown()
  // Remembered destinations rejoin the engine as soon as settings open.
  useEffect(() => {
    if (engine && scheduler) void restoreDestinations(rt, engine, scheduler)
  }, [rt, engine, scheduler])
  // Pairing hands backups over: until there is one, the Sync page offers it (to receive them on a new device).
  const hasBackup = (status?.dests.length ?? 0) > 0
  return (
    <Screen title={t('settings.title')}>
      <Appearance />
      <ListGroup title={t('settings.groupStudy')}>
        <ListRow href={paths.settingsReview} leading={<CalendarCheck size={ICON} />} title={t('common.setReview')} />
        <ListRow
          href={paths.settingsAi}
          leading={<Sparkles size={ICON} />}
          title={t('common.setAi')}
          subtitle={aiShown ? undefined : t('settings.aiHidden')}
        />
      </ListGroup>
      <ListGroup title={t('settings.groupDevices')}>
        <ListRow
          href={paths.settingsSync}
          leading={<Cloud size={ICON} />}
          title={t('settings.sync')}
          trailing={<SyncBadge summary={summary} />}
        />
        {hasBackup && (
          <ListRow href={paths.settingsPair} leading={<Smartphone size={ICON} />} title={t('sync.pairDevice')} />
        )}
      </ListGroup>
      <ListGroup title={t('settings.groupData')}>
        <ListRow href={paths.settingsData} leading={<Database size={ICON} />} title={t('common.setData')} />
        <ListRow href={paths.trash} leading={<Trash2 size={ICON} />} title={t('common.trashTitle')} />
        <ListRow
          href={paths.settingsSecurity}
          leading={<LockKeyhole size={ICON} />}
          title={t('common.setSecurity')}
          subtitle={t('settings.securitySub')}
        />
      </ListGroup>
      <ListGroup title={t('settings.groupHelp')}>
        <ListRow href={paths.onboarding} leading={<Info size={ICON} />} title={t('common.welcomeTitle')} />
        <ListRow
          href={paths.settingsDiagnostic}
          leading={<FileText size={ICON} />}
          title={t('common.setDiagnostic')}
          subtitle={t('settings.diagnosticSub')}
        />
      </ListGroup>
    </Screen>
  )
}
