/**
 * The language a text is written in, from its function words (articles, pronouns, prepositions, auxiliaries):
 * no model, no dictionary, a few hundred bytes. It answers only when the text is long enough and one language
 * clearly leads; a short text, a list of terms or a text mixing two languages gives `undefined`, and the caller
 * falls back (the course's language, then the interface's).
 */

/** BCP 47 codes `detectLanguage` can answer. */
export type DetectedLanguage = 'en' | 'de' | 'fr' | 'es' | 'it' | 'nl' | 'pt'

/** Frequent words of each language, chosen to tell them apart (a word shared by several counts for each). */
const FUNCTION_WORDS: Readonly<Record<DetectedLanguage, readonly string[]>> = {
  en: [
    'the',
    'and',
    'of',
    'to',
    'is',
    'are',
    'that',
    'this',
    'with',
    'for',
    'it',
    'as',
    'be',
    'by',
    'on',
    'from',
    'which',
    'was',
    'were',
    'has',
    'have',
    'not',
    'or',
    'an',
    'can',
    'its',
    'into',
    'their',
    'these',
    'when',
  ],
  de: [
    'der',
    'die',
    'das',
    'und',
    'ist',
    'nicht',
    'ein',
    'eine',
    'einen',
    'mit',
    'den',
    'dem',
    'des',
    'von',
    'zu',
    'auf',
    'sich',
    'auch',
    'im',
    'für',
    'wird',
    'werden',
    'sind',
    'bei',
    'oder',
    'durch',
    'nach',
    'wie',
    'über',
    'zum',
    'zur',
    'kann',
    'wenn',
  ],
  fr: [
    'le',
    'la',
    'les',
    'et',
    'est',
    'des',
    'une',
    'un',
    'du',
    'que',
    'qui',
    'dans',
    'pour',
    'pas',
    'sur',
    'au',
    'aux',
    'ce',
    'cette',
    'sont',
    'avec',
    'par',
    'ou',
    'il',
    'elle',
    'se',
    'ne',
    'plus',
    'leur',
    'être',
    'sa',
  ],
  es: [
    'el',
    'la',
    'los',
    'las',
    'y',
    'es',
    'del',
    'que',
    'una',
    'un',
    'por',
    'con',
    'para',
    'en',
    'se',
    'no',
    'al',
    'lo',
    'como',
    'más',
    'pero',
    'su',
    'sus',
    'está',
    'son',
    'muy',
    'entre',
    'cuando',
    'también',
    'hay',
  ],
  it: [
    'il',
    'lo',
    'la',
    'gli',
    'le',
    'e',
    'è',
    'di',
    'che',
    'una',
    'un',
    'per',
    'con',
    'del',
    'della',
    'non',
    'sono',
    'si',
    'nel',
    'nella',
    'dei',
    'delle',
    'alla',
    'anche',
    'come',
    'più',
    'questo',
    'questa',
    'ha',
    'ed',
  ],
  nl: [
    'de',
    'het',
    'een',
    'en',
    'van',
    'is',
    'dat',
    'die',
    'niet',
    'op',
    'te',
    'met',
    'voor',
    'zijn',
    'er',
    'aan',
    'ook',
    'als',
    'bij',
    'door',
    'wordt',
    'worden',
    'maar',
    'om',
    'naar',
    'deze',
    'wat',
    'uit',
    'kan',
    'wel',
  ],
  pt: [
    'o',
    'a',
    'os',
    'as',
    'e',
    'é',
    'do',
    'da',
    'dos',
    'das',
    'que',
    'um',
    'uma',
    'não',
    'em',
    'no',
    'na',
    'para',
    'com',
    'por',
    'se',
    'mais',
    'são',
    'ao',
    'pela',
    'pelo',
    'também',
    'muito',
    'nos',
    'nas',
    'está',
  ],
}

const LANGUAGES = Object.keys(FUNCTION_WORDS) as DetectedLanguage[]
const INDEX = new Map<string, DetectedLanguage[]>()
for (const lang of LANGUAGES) {
  for (const w of FUNCTION_WORDS[lang]) INDEX.set(w, [...(INDEX.get(w) ?? []), lang])
}

/** Fewer words than this is too short to tell. */
export const MIN_WORDS = 12
/** At most this much of a long text is read: the start is representative enough, and the cost stays flat. */
const MAX_CHARS = 20_000
/** The leading language needs this many function words … */
const MIN_HITS = 4
/** … this share of all the words … */
const MIN_SHARE = 0.12
/** … and this many times the hits of the next language. */
const MIN_LEAD = 1.5

const WORD = /\p{L}+/gu

/** Words per stretch when looking for a second language: about a sentence or two. */
const STRETCH = 20

/** The language of `text` as a BCP 47 code, or `undefined` when it is too short, mixed or none of those known. */
export function detectLanguage(text: string | undefined): DetectedLanguage | undefined {
  if (!text) return undefined
  const words = text.slice(0, MAX_CHARS).toLowerCase().match(WORD) ?? []
  if (words.length < MIN_WORDS) return undefined
  const lang = leading(words)
  if (lang === undefined) return undefined
  // Mixed: stretches of the text read as another language about half as often as the leading one.
  const votes = new Map<DetectedLanguage, number>()
  for (let i = 0; i < words.length; i += STRETCH) {
    const stretch = words.slice(i, i + STRETCH)
    const found = stretch.length >= MIN_WORDS ? leading(stretch) : undefined
    if (found) votes.set(found, (votes.get(found) ?? 0) + 1)
  }
  const own = votes.get(lang) ?? 0
  const other = Math.max(0, ...[...votes].filter(([l]) => l !== lang).map(([, n]) => n))
  return other > 0 && other * 2 >= own ? undefined : lang
}

/** The language clearly ahead in these words, if any. */
function leading(words: readonly string[]): DetectedLanguage | undefined {
  const hits = new Map<DetectedLanguage, number>()
  for (const w of words) for (const lang of INDEX.get(w) ?? []) hits.set(lang, (hits.get(lang) ?? 0) + 1)
  const ranked = [...hits].sort((a, b) => b[1] - a[1])
  const [first, second] = ranked
  if (!first) return undefined
  const [lang, n] = first
  if (n < MIN_HITS || n / words.length < MIN_SHARE) return undefined
  if (second && n < second[1] * MIN_LEAD) return undefined
  return lang
}
