import type { Guard } from '../storage/guard'
import { type DestinationKeyring, PASSPHRASE_MIN_LENGTH } from './keyring'

/**
 * The app password used as the encryption passphrase of some backups. Nothing new is stored or sent: the
 * password is only the passphrase typed into the usual key files. The guard verifier stays in the device-only
 * `kv` store and uses the same KDF as `keys/*.json`, so it offers no cheaper guess than the key files do.
 */
export type PasswordUse = 'ok' | 'wrong' | 'short'

/** Whether `password` is this device's app password, long enough to be a passphrase. */
export async function passwordAsPassphrase(guard: Guard, password: string): Promise<PasswordUse> {
  if (!(await guard.verify(password))) return 'wrong'
  return password.length < PASSPHRASE_MIN_LENGTH ? 'short' : 'ok'
}

/**
 * Changes the app password and, first, the passphrase of every backup it encrypts: each keyring gets a key
 * file for the same data key under the new password (uploaded by the next sync round). Key files are
 * immutable, so the old password keeps opening the old ones. Nothing changes when `current` is wrong or
 * `next` is too short for a passphrase; a keyring that `current` does not open throws before the password
 * changes (the key files already added are harmless: they only open with `next`).
 */
export async function changePassword(o: {
  guard: Guard
  rings: DestinationKeyring[]
  current: string
  next: string
}): Promise<PasswordUse> {
  if (!(await o.guard.verify(o.current))) return 'wrong'
  if (o.rings.length > 0 && o.next.length < PASSPHRASE_MIN_LENGTH) return 'short'
  for (const ring of o.rings) await ring.learn([await ring.changePassphrase(o.current, o.next)])
  return (await o.guard.change(o.current, o.next)) ? 'ok' : 'wrong'
}
