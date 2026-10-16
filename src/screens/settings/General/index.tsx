import { Redirect } from 'wouter'
import { paths } from '../../../app/routes.ts'

/** The appearance and the language are at the top of the settings now: older links land there. */
export default function GeneralRedirect() {
  return <Redirect to={paths.settings} replace />
}
