import { Redirect } from 'wouter'
import { paths } from '../../../app/routes.ts'

/** Encryption lives on the Security page now, under the password that can lock it: older links land there. */
export default function SealRedirect() {
  return <Redirect to={`${paths.settingsSecurity}?at=encryption`} replace />
}
