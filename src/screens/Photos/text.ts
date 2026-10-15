import { intlTag } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import type { CaptureFailure } from './capture.ts'

export function useFailureText(): (f: CaptureFailure) => string {
  const t = useT()
  return (f) =>
    f.reason === 'heic'
      ? t('photos.heic', { name: f.name })
      : f.reason === 'too-large'
        ? t('photos.tooLarge', { name: f.name })
        : t('photos.unreadable', { name: f.name })
}

/** "Photo 14 Oct 2026, 10:42": the title of a photo whose file had no useful name. */
export function useUntitled(): () => string {
  const t = useT()
  const locale = useLocale()
  return () =>
    t('photos.untitled', {
      date: new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()),
    })
}
