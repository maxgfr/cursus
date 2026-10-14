import type { Translate } from '../../i18n/index.ts'

/** Why a request or a save failed, in the student's words: what happened, then what to do next. */
export function describeFailure(error: unknown, t: Translate, online: boolean = navigator.onLine): string {
  const name = error instanceof Error ? error.name : ''
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : Number.NaN
  if (name === 'LocalQuotaError' || name === 'QuotaExceededError')
    return `${t('errors.storageFull')} ${t('errors.storageFullNext')}`
  if (!online || (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)))
    return `${t('errors.network')} ${t('errors.networkNext')}`
  if (status === 401 || status === 403) return `${t('errors.invalidKey')} ${t('errors.invalidKeyNext')}`
  if (status === 429) return `${t('errors.rateLimited')} ${t('errors.rateLimitedNext')}`
  if (status === 402) return `${t('errors.quotaExceeded')} ${t('errors.quotaExceededNext')}`
  return `${t('errors.generic')} ${t('errors.genericNext')}`
}
