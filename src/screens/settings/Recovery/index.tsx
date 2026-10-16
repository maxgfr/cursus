import { Redirect } from 'wouter'
import { paths } from '../../../app/routes.ts'

/** Recovery lives on the Security page now, with the password and erasing: older links land on its section. */
export default function RecoveryRedirect() {
  return <Redirect to={`${paths.settingsSecurity}?at=recovery`} replace />
}
