import { ai as deAi } from '../../src/i18n/de/ai.ts'
import { common as deCommon } from '../../src/i18n/de/common.ts'
import { course as deCourse } from '../../src/i18n/de/course.ts'
import { review as deReview } from '../../src/i18n/de/review.ts'
import { today as deToday } from '../../src/i18n/de/today.ts'
import { ai as enAi } from '../../src/i18n/en/ai.ts'
import { common as enCommon } from '../../src/i18n/en/common.ts'
import { course as enCourse } from '../../src/i18n/en/course.ts'
import { review as enReview } from '../../src/i18n/en/review.ts'
import { today as enToday } from '../../src/i18n/en/today.ts'
import { ai as frAi } from '../../src/i18n/fr/ai.ts'
import { common as frCommon } from '../../src/i18n/fr/common.ts'
import { course as frCourse } from '../../src/i18n/fr/course.ts'
import { review as frReview } from '../../src/i18n/fr/review.ts'
import { today as frToday } from '../../src/i18n/fr/today.ts'

type Message = string | { readonly one: string; readonly other: string }
type Table = Readonly<Record<string, Message>>

const CATALOGS: Readonly<Record<'en' | 'de' | 'fr', Readonly<Record<string, Table>>>> = {
  en: { ai: enAi, common: enCommon, course: enCourse, review: enReview, today: enToday },
  de: { ai: deAi, common: deCommon, course: deCourse, review: deReview, today: deToday },
  fr: { ai: frAi, common: frCommon, course: frCourse, review: frReview, today: frToday },
}

export type Tr = (key: string, params?: Readonly<Record<string, string | number>>) => string

/**
 * What the app shows for a catalog key in a language (same plural rules and placeholders): a test reads the screen
 * in every language without copying its strings.
 */
export function translator(locale: 'en' | 'de' | 'fr'): Tr {
  const rules = new Intl.PluralRules(locale)
  const numbers = new Intl.NumberFormat(locale)
  return (key, params) => {
    const dot = key.indexOf('.')
    const message = CATALOGS[locale][key.slice(0, dot)]?.[key.slice(dot + 1)]
    if (message === undefined) throw new Error(`no catalog key ${key}`)
    const template =
      typeof message === 'string'
        ? message
        : rules.select(Number(params?.count)) === 'one'
          ? message.one
          : message.other
    return template.replace(/\{(\w+)\}/g, (all, name: string) => {
      const value = params?.[name]
      if (value === undefined) return all
      return typeof value === 'number' ? numbers.format(value) : value
    })
  }
}

/**
 * A string as a literal piece of a regular expression. Its spaces match any white space: an accessible name gives
 * a no-break space (French « Démo\u00a0: ») back as a plain one.
 */
export const literal = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
