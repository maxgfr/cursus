import { Cloud } from 'lucide-react'
import { paths } from '../../../app/routes.ts'
import { useSync } from '../../../app/syncContext.tsx'
import { useT } from '../../../i18n/react.tsx'
import { SyncBadge } from '../../../ui/components/Badges.tsx'
import { EmptyState } from '../../../ui/components/EmptyState.tsx'
import { ListGroup, ListRow } from '../../../ui/components/List.tsx'
import { Screen } from '../../../ui/shell/Screen.tsx'

export default function SyncSettings() {
  const t = useT()
  const { status, summary } = useSync()
  const dests = status?.dests ?? []
  return (
    <Screen title={t('settings.sync')} back={paths.settings} trailing={<SyncBadge summary={summary} />}>
      {dests.length === 0 ? (
        <EmptyState icon={Cloud} title={t('common.syncEmpty')} />
      ) : (
        <ListGroup title={t('sync.destinations')}>
          {dests.map((d) => (
            <ListRow
              key={d.id}
              title={d.label}
              subtitle={d.unconfirmed > 0 ? t('sync.pending', { count: d.unconfirmed }) : t('sync.synced')}
            />
          ))}
        </ListGroup>
      )}
    </Screen>
  )
}
