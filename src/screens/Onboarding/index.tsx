import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { buttonClass } from '../../ui/components/Button.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './Onboarding.module.css'

export default function Onboarding() {
  const t = useT()
  return (
    <Screen title={t('common.welcomeTitle')}>
      <p className={styles.lead}>{t('common.welcomeBody')}</p>
      <Link href={paths.today} className={buttonClass({ variant: 'primary', size: 'large', full: true })}>
        {t('common.start')}
      </Link>
    </Screen>
  )
}
