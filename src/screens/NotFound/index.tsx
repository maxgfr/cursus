import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

/** Unknown route, or an entity that no longer exists (purged, or trashed elsewhere). */
export default function NotFound() {
  const t = useT()
  return (
    <Screen title={t('common.notFoundTitle')}>
      <EmptyState
        title={t('errors.notFound')}
        body={t('common.notFoundBody')}
        action={
          <Link href={paths.today} className={buttonClass({ variant: 'secondary' })}>
            {t('common.backToday')}
          </Link>
        }
      />
    </Screen>
  )
}
