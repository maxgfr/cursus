import { ai as deAi } from './de/ai.ts'
import { anki as deAnki } from './de/anki.ts'
import { common as deCommon } from './de/common.ts'
import { course as deCourse } from './de/course.ts'
import { errors as deErrors } from './de/errors.ts'
import { review as deReview } from './de/review.ts'
import { settings as deSettings } from './de/settings.ts'
import { sync as deSync } from './de/sync.ts'
import { today as deToday } from './de/today.ts'
import { ai } from './en/ai.ts'
import { anki } from './en/anki.ts'
import { common } from './en/common.ts'
import { course } from './en/course.ts'
import { errors } from './en/errors.ts'
import { review } from './en/review.ts'
import { settings } from './en/settings.ts'
import { sync } from './en/sync.ts'
import { today } from './en/today.ts'
import { ai as frAi } from './fr/ai.ts'
import { anki as frAnki } from './fr/anki.ts'
import { common as frCommon } from './fr/common.ts'
import { course as frCourse } from './fr/course.ts'
import { errors as frErrors } from './fr/errors.ts'
import { review as frReview } from './fr/review.ts'
import { settings as frSettings } from './fr/settings.ts'
import { sync as frSync } from './fr/sync.ts'
import { today as frToday } from './fr/today.ts'
import { pseudoCatalog } from './pseudo.ts'

export interface Plural {
  readonly one: string
  readonly other: string
}

export type Message = string | Plural

/** Widened shape of a source namespace: same keys, any string values. */
export type Shape<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : T[K] extends Plural ? Plural : never
}

export const en = { common, today, course, review, ai, settings, sync, anki, errors } as const

type Source = typeof en
export type Namespace = keyof Source
export type Catalog = { readonly [N in Namespace]: Shape<Source[N]> }

export const de: Catalog = {
  common: deCommon,
  today: deToday,
  course: deCourse,
  review: deReview,
  ai: deAi,
  settings: deSettings,
  sync: deSync,
  anki: deAnki,
  errors: deErrors,
}

export const fr: Catalog = {
  common: frCommon,
  today: frToday,
  course: frCourse,
  review: frReview,
  ai: frAi,
  settings: frSettings,
  sync: frSync,
  anki: frAnki,
  errors: frErrors,
}

export const LOCALES = ['en', 'de', 'fr'] as const
export type BaseLocale = (typeof LOCALES)[number]
export type Locale = BaseLocale | 'pseudo'

export const catalogs: { readonly [L in Locale]: Catalog } = {
  en,
  de,
  fr,
  pseudo: pseudoCatalog(en),
}

type KeysOf<N extends Namespace> = Extract<keyof Source[N], string>
export type Key = { [N in Namespace]: `${N}.${KeysOf<N>}` }[Namespace]

type PluralKey = {
  [N in Namespace]: { [K in KeysOf<N>]: Source[N][K] extends Plural ? `${N}.${K}` : never }[KeysOf<N>]
}[Namespace]

export type Params = Readonly<Record<string, string | number>>

export type Translate = {
  (key: Exclude<Key, PluralKey>, params?: Params): string
  (key: PluralKey, params: Params & { readonly count: number }): string
}

const PLACEHOLDER = /\{(\w+)\}/g

export function interpolate(template: string, params: Params | undefined, format: (n: number) => string): string {
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params?.[name]
    if (value === undefined) return match
    return typeof value === 'number' ? format(value) : value
  })
}

export function lookup(catalog: Catalog, key: string): Message | undefined {
  const dot = key.indexOf('.')
  const ns = key.slice(0, dot)
  const name = key.slice(dot + 1)
  if (!isNamespace(ns)) return undefined
  const table: Readonly<Record<string, Message>> = catalog[ns]
  return table[name]
}

function isNamespace(value: string): value is Namespace {
  return Object.hasOwn(en, value)
}

/** BCP-47 tag used by Intl for a locale (pseudo formats like English). */
export function intlTag(locale: Locale): BaseLocale {
  return locale === 'pseudo' ? 'en' : locale
}

export function createTranslator(locale: Locale): Translate {
  const catalog = catalogs[locale]
  const tag = intlTag(locale)
  const rules = new Intl.PluralRules(tag)
  const numbers = new Intl.NumberFormat(tag)
  const translate = (key: string, params?: Params): string => {
    const message = lookup(catalog, key) ?? lookup(en, key)
    if (message === undefined) throw new Error(`i18n: unknown key "${key}"`)
    let template: string
    if (typeof message === 'string') {
      template = message
    } else {
      const count = params?.count
      if (typeof count !== 'number') throw new Error(`i18n: plural key "${key}" needs a numeric count`)
      template = rules.select(count) === 'one' ? message.one : message.other
    }
    return interpolate(template, params, (n) => numbers.format(n))
  }
  return translate as Translate
}

export function isLocale(value: string | null | undefined): value is Locale {
  return value === 'pseudo' || LOCALES.some((l) => l === value)
}

export interface DetectInput {
  /** Explicit `?locale=` query value. */
  readonly query?: string | null
  /** Locale chosen by the user on this device. */
  readonly stored?: string | null
  /** `navigator.languages`. */
  readonly languages?: readonly string[]
}

/** Query override, then device preference, then navigator.languages, then en. */
export function detectLocale(input: DetectInput): Locale {
  if (isLocale(input.query)) return input.query
  if (isLocale(input.stored) && input.stored !== 'pseudo') return input.stored
  for (const tag of input.languages ?? []) {
    const base = tag.toLowerCase().split('-')[0]
    if (isLocale(base) && base !== 'pseudo') return base
  }
  return 'en'
}

/** Reads the environment (if any) to detect the locale; safe without a DOM. */
export function detectFromEnvironment(stored?: string | null): Locale {
  const query = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('locale')
  const languages = typeof navigator === 'undefined' ? [] : navigator.languages
  return detectLocale({ query, stored, languages })
}

/** Updates `<html lang>` when a document exists. */
export function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale === 'pseudo' ? 'en-XA' : locale
}
