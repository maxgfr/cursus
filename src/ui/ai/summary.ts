import type { useT } from '../../i18n/react.tsx'

type T = ReturnType<typeof useT>

/** The summary of the sources an AI action uses, at a glance (« Sources: all of Biology »). */
export function sourcesSummary(t: T, s: { place: string; chosen: number; total: number; pasted: boolean }): string {
  let sources: string
  if (s.place === '' || (s.total > 0 && s.chosen === 0)) {
    if (s.pasted) return t('ai.sheetSourcesPasted')
    sources = t('ai.sheetSourcesNone')
  } else if (s.total === 0) {
    if (s.pasted) return t('ai.sheetSourcesPasted')
    sources = t('ai.sheetSourcesEmpty', { place: s.place })
  } else if (s.chosen === s.total) {
    sources = t('ai.sheetSourcesAll', { place: s.place })
  } else {
    sources = t('ai.sheetSourcesSome', { count: s.chosen, total: s.total, place: s.place })
  }
  return s.pasted ? t('ai.sheetPlusPasted', { sources }) : sources
}
