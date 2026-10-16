import { Redirect } from 'wouter'
import { paths } from '../../../app/routes.ts'

/** Encryption lives on the Sync page now, under the backups it protects: older links land there. */
export default function SealRedirect() {
  return <Redirect to={`${paths.settingsSync}?at=encryption`} replace />
}
