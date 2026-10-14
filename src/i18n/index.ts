import type { ai } from './en/ai.ts'
import type { anki } from './en/anki.ts'
import type { common } from './en/common.ts'
import type { course } from './en/course.ts'
import type { errors } from './en/errors.ts'
import type { review } from './en/review.ts'
import type { settings } from './en/settings.ts'
import type { sync } from './en/sync.ts'
import type { today } from './en/today.ts'

export interface Plural {
  readonly one: string
  readonly other: string
}

export type Message = string | Plural

/** Widened shape of a source namespace: same keys, any string values. */
export type Shape<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : T[K] extends Plural ? Plural : never
}

/** The source language: English defines every key (and its types); it loads like any other locale. */
type Source = {
  readonly common: typeof common
  readonly today: typeof today
  readonly course: typeof course
  readonly review: typeof review
  readonly ai: typeof ai
  readonly settings: typeof settings
  readonly sync: typeof sync
  readonly anki: typeof anki
  readonly errors: typeof errors
}
const NAMESPACES: readonly Namespace[] = [
  'common',
  'today',
  'course',
  'review',
  'ai',
  'settings',
  'sync',
  'anki',
  'errors',
]
export type Namespace = keyof Source
export type Catalog = { readonly [N in Namespace]: Shape<Source[N]> }

export const LOCALES = ['en', 'de', 'fr'] as const
export type BaseLocale = (typeof LOCALES)[number]
export type Locale = BaseLocale | 'pseudo'

/**
 * No catalog ships in the initial bundle: the one locale in use is fetched once, while the library opens
 * (the other languages never weigh on a device that does not use them).
 */
const loaded = new Map<Locale, Catalog>()

const loaders: { readonly [L in Locale]: () => Promise<Catalog> } = {
  en: async () => {
    const [common, today, course, review, ai, settings, sync, anki, errors] = await Promise.all([
      import('./en/common.ts'),
      import('./en/today.ts'),
      import('./en/course.ts'),
      import('./en/review.ts'),
      import('./en/ai.ts'),
      import('./en/settings.ts'),
      import('./en/sync.ts'),
      import('./en/anki.ts'),
      import('./en/errors.ts'),
    ])
    return {
      common: common.common,
      today: today.today,
      course: course.course,
      review: review.review,
      ai: ai.ai,
      settings: settings.settings,
      sync: sync.sync,
      anki: anki.anki,
      errors: errors.errors,
    }
  },
  de: async () => {
    const [common, today, course, review, ai, settings, sync, anki, errors] = await Promise.all([
      import('./de/common.ts'),
      import('./de/today.ts'),
      import('./de/course.ts'),
      import('./de/review.ts'),
      import('./de/ai.ts'),
      import('./de/settings.ts'),
      import('./de/sync.ts'),
      import('./de/anki.ts'),
      import('./de/errors.ts'),
    ])
    return {
      common: common.common,
      today: today.today,
      course: course.course,
      review: review.review,
      ai: ai.ai,
      settings: settings.settings,
      sync: sync.sync,
      anki: anki.anki,
      errors: errors.errors,
    }
  },
  fr: async () => {
    const [common, today, course, review, ai, settings, sync, anki, errors] = await Promise.all([
      import('./fr/common.ts'),
      import('./fr/today.ts'),
      import('./fr/course.ts'),
      import('./fr/review.ts'),
      import('./fr/ai.ts'),
      import('./fr/settings.ts'),
      import('./fr/sync.ts'),
      import('./fr/anki.ts'),
      import('./fr/errors.ts'),
    ])
    return {
      common: common.common,
      today: today.today,
      course: course.course,
      review: review.review,
      ai: ai.ai,
      settings: settings.settings,
      sync: sync.sync,
      anki: anki.anki,
      errors: errors.errors,
    }
  },
  pseudo: async () => {
    const [{ pseudoCatalog }, en] = await Promise.all([import('./pseudo.ts'), loadCatalog('en')])
    return pseudoCatalog(en)
  },
}

/** The catalog of a locale once loaded. */
export function loadedCatalog(locale: Locale): Catalog | undefined {
  return loaded.get(locale)
}

/** Fetches a locale's catalog (once); a translator for it can then be created synchronously. */
export async function loadCatalog(locale: Locale): Promise<Catalog> {
  const have = loaded.get(locale)
  if (have) return have
  const catalog = await loaders[locale]()
  loaded.set(locale, catalog)
  return catalog
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
  return NAMESPACES.some((n) => n === value)
}

/** BCP-47 tag used by Intl for a locale (pseudo formats like English). */
export function intlTag(locale: Locale): BaseLocale {
  return locale === 'pseudo' ? 'en' : locale
}

/** A translator for a loaded locale (see `loadCatalog`). */
export function createTranslator(locale: Locale): Translate {
  const catalog = loaded.get(locale)
  if (catalog === undefined) throw new Error(`i18n: catalog "${locale}" is not loaded`)
  const tag = intlTag(locale)
  const rules = new Intl.PluralRules(tag)
  const numbers = new Intl.NumberFormat(tag)
  const translate = (key: string, params?: Params): string => {
    const english = loaded.get('en')
    const message = lookup(catalog, key) ?? (english === undefined ? undefined : lookup(english, key))
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
