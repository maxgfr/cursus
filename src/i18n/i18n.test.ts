import { describe, expect, test } from 'bun:test'
import { formatDuration, formatRelative, formatUsd } from './format.ts'
import {
  applyDocumentLocale,
  type Catalog,
  createTranslator,
  detectLocale,
  intlTag,
  loadCatalog,
  type Message,
  regionalTag,
} from './index.ts'
import { pseudoize } from './pseudo.ts'

// Catalogs load on demand (only the locale in use is fetched by the app).
const en = await loadCatalog('en')
const de = await loadCatalog('de')
const fr = await loadCatalog('fr')
const catalogs = { en, de, fr, pseudo: await loadCatalog('pseudo') }

function flatten(catalog: Catalog): Map<string, Message> {
  const out = new Map<string, Message>()
  for (const [ns, table] of Object.entries(catalog)) {
    const entries: Readonly<Record<string, Message>> = table
    for (const [k, m] of Object.entries(entries)) out.set(`${ns}.${k}`, m)
  }
  return out
}

const placeholders = (m: Message): string[] => {
  const texts = typeof m === 'string' ? [m] : [m.one, m.other]
  return [...new Set(texts.flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1] ?? '')))].sort()
}

const source = flatten(en)

describe('catalogs', () => {
  for (const [name, catalog] of Object.entries({ de, fr, pseudo: catalogs.pseudo })) {
    test(`${name} has the same keys, kinds and placeholders as en`, () => {
      const flat = flatten(catalog)
      expect([...flat.keys()].sort()).toEqual([...source.keys()].sort())
      for (const [key, m] of source) {
        const other = flat.get(key)
        expect(other).toBeDefined()
        if (other === undefined) continue
        expect([key, typeof other]).toEqual([key, typeof m])
        expect([key, placeholders(other)]).toEqual([key, placeholders(m)])
      }
    })
  }

  test('no empty strings anywhere', () => {
    for (const catalog of Object.values(catalogs)) {
      for (const [key, m] of flatten(catalog)) {
        const texts = typeof m === 'string' ? [m] : [m.one, m.other]
        for (const s of texts) expect([key, s.trim().length > 0]).toEqual([key, true])
      }
    }
  })

  test('plural messages reference {count}', () => {
    for (const [key, m] of source)
      if (typeof m !== 'string') expect([key, placeholders(m).includes('count')]).toEqual([key, true])
  })
})

describe('t()', () => {
  test('interpolates and pluralises per locale', () => {
    const tEn = createTranslator('en')
    expect(tEn('today.due', { count: 1 })).toBe('1 card due')
    expect(tEn('today.due', { count: 3 })).toBe('3 cards due')
    expect(tEn('sync.protected', { count: 2 })).toBe('Protected on 2 destinations')
    expect(tEn('course.deleteConfirm', { name: 'Bio' })).toBe('Delete “Bio” and all its cards?')
    const tDe = createTranslator('de')
    expect(tDe('today.due', { count: 1 })).toBe('1 Karte fällig')
    expect(tDe('today.due', { count: 0 })).toBe('0 Karten fällig')
    const tFr = createTranslator('fr')
    expect(tFr('today.due', { count: 0 })).toBe('0 carte à revoir')
    expect(tFr('today.due', { count: 1 })).toBe('1 carte à revoir')
    expect(tFr('today.due', { count: 2 })).toBe('2 cartes à revoir')
    expect(tFr('review.why')).toBe('Pourquoi ?')
  })

  test('formats numbers in placeholders', () => {
    expect(createTranslator('de')('course.cardCount', { count: 1200 })).toBe('1.200 Karten')
  })

  test('plural without count throws', () => {
    const t = createTranslator('en') as unknown as (k: string) => string
    expect(() => t('today.due')).toThrow(/count/)
    expect(() => t('nope.key')).toThrow(/unknown key/)
  })

  test('pseudo locale accents, brackets and expands', () => {
    const out = pseudoize('Show answer {count}')
    expect(out.startsWith('[')).toBe(true)
    expect(out.endsWith(']')).toBe(true)
    expect(out).toContain('{count}')
    expect(out).toContain('Šĥóŵ')
    expect(out.length).toBeGreaterThanOrEqual(Math.ceil('Show answer {count}'.length * 1.35))
    expect(createTranslator('pseudo')('review.good')).toBe(pseudoize('Good'))
  })
})

describe('detectLocale', () => {
  test('query, then device preference, then navigator.languages, then en', () => {
    expect(detectLocale({ query: 'pseudo', stored: 'de' })).toBe('pseudo')
    expect(detectLocale({ stored: 'fr', languages: ['de-DE'] })).toBe('fr')
    expect(detectLocale({ languages: ['es-ES', 'de-AT', 'fr'] })).toBe('de')
    expect(detectLocale({ languages: ['ja'] })).toBe('en')
    expect(detectLocale({})).toBe('en')
  })

  test('applyDocumentLocale is safe without a DOM', () => {
    expect(() => applyDocumentLocale('fr')).not.toThrow()
  })
})

describe('format', () => {
  test('usd, relative time, durations', () => {
    expect(formatUsd('en', 1.5)).toBe('$1.50')
    expect(formatUsd('en', 0.0042)).toBe('$0.0042')
    expect(formatRelative('en', 3 * 86400_000, 0)).toBe('in 3 days')
    expect(formatRelative('fr', -86400_000, 0)).toBe('hier')
    expect(formatDuration('en', 3_900_000)).toBe('1 hr 5 min')
  })
})

describe('regional formats', () => {
  const day = new Date(Date.UTC(2026, 9, 14, 12))
  const long = (tag: string) =>
    new Intl.DateTimeFormat(tag, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(day)

  test('en-GB device: day before month', () => {
    expect(intlTag('en', ['en-GB'])).toBe('en-GB')
    expect(long(intlTag('en', ['en-GB']))).toBe('Wednesday 14 October')
  })

  test('de-CH device: Swiss grouping', () => {
    expect(new Intl.NumberFormat(intlTag('de', ['de-CH', 'en'])).format(12345.6)).toMatch(/^12['’]345\.6$/)
  })

  test('first device language of the same base wins; fr-CA keeps its conventions', () => {
    expect(intlTag('fr', ['en-GB', 'fr-CA', 'fr-FR'])).toBe('fr-CA')
  })

  test('explicit pick with no matching device language: that language’s default region', () => {
    expect(intlTag('de', ['en-GB'])).toBe('de-DE')
    expect(intlTag('fr', [])).toBe('fr-FR')
    expect(intlTag('en', ['de-CH'])).toBe('en-US')
  })

  test('malformed tags are skipped; pseudo stays en-XA for <html lang>', () => {
    expect(intlTag('en', ['en_GB!', 'en-AU'])).toBe('en-AU')
    expect(regionalTag('pseudo', ['en-GB'])).toBe('en-XA')
  })
})
