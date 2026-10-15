import { describe, expect, test } from 'bun:test'
import { detectLanguage, MIN_WORDS } from './language'

const SAMPLES = {
  en: 'The cell membrane is a thin layer that separates the inside of the cell from its environment. It is made of lipids and proteins, and it controls which molecules can enter or leave the cell.',
  de: 'Die Zellmembran ist eine dünne Schicht, die das Innere der Zelle von ihrer Umgebung trennt. Sie besteht aus Lipiden und Proteinen und kontrolliert, welche Moleküle in die Zelle gelangen oder sie verlassen.',
  fr: 'La membrane cellulaire est une fine couche qui sépare l’intérieur de la cellule de son environnement. Elle est composée de lipides et de protéines, et elle contrôle les molécules qui entrent dans la cellule ou qui en sortent.',
  es: 'La membrana celular es una capa delgada que separa el interior de la célula de su entorno. Está formada por lípidos y proteínas, y controla qué moléculas pueden entrar o salir de la célula.',
  it: 'La membrana cellulare è uno strato sottile che separa l’interno della cellula dal suo ambiente. È composta da lipidi e proteine, e controlla quali molecole possono entrare o uscire dalla cellula.',
  nl: 'Het celmembraan is een dunne laag die de binnenkant van de cel scheidt van de omgeving. Het bestaat uit lipiden en eiwitten en het bepaalt welke moleculen de cel in of uit kunnen gaan.',
  pt: 'A membrana celular é uma camada fina que separa o interior da célula do seu ambiente. Ela é formada por lipídios e proteínas, e controla quais moléculas podem entrar ou sair da célula.',
} as const

describe('detectLanguage', () => {
  for (const [lang, text] of Object.entries(SAMPLES)) {
    test(`a paragraph in ${lang}`, () => {
      expect(detectLanguage(text)).toBe(lang as keyof typeof SAMPLES)
    })
  }

  test('course material: slide text with headings and bullet points', () => {
    const de = [
      'Klinische Chemie',
      'Die Bestimmung der Elektrolyte im Serum',
      '- Natrium und Kalium werden mit ionenselektiven Elektroden gemessen',
      '- Der Referenzbereich hängt von der Methode ab',
      'Bei einer Hyponatriämie ist die Osmolalität meist erniedrigt, und die Ursache wird über das Volumen gesucht.',
    ].join('\n')
    expect(detectLanguage(de)).toBe('de')
  })

  test('too short, empty, numbers or a list of terms: no answer', () => {
    expect(detectLanguage(undefined)).toBeUndefined()
    expect(detectLanguage('')).toBeUndefined()
    expect(detectLanguage('Die Zelle')).toBeUndefined()
    expect(detectLanguage('The cell membrane is thin.')).toBeUndefined()
    expect(detectLanguage('12 34 56 78 90 1.5 2.5 3.5 4.5 5.5 6.5 7.5 8.5 9.5')).toBeUndefined()
    expect(
      detectLanguage(
        'Natrium Kalium Chlorid Bikarbonat Glukose Harnstoff Kreatinin Albumin Bilirubin Laktat Ammoniak Troponin',
      ),
    ).toBeUndefined()
    expect(MIN_WORDS).toBeGreaterThan(5)
  })

  test('two languages half and half: no answer', () => {
    expect(detectLanguage(`${SAMPLES.de} ${SAMPLES.fr}`)).toBeUndefined()
    expect(detectLanguage(`${SAMPLES.en} ${SAMPLES.de}`)).toBeUndefined()
  })

  test('a quotation in another language does not change the answer', () => {
    const text = `${SAMPLES.fr} ${SAMPLES.fr} Comme on dit en anglais : « the cell is the unit of life ».`
    expect(detectLanguage(text)).toBe('fr')
  })

  test('a very long text is read from its start, in bounded time', () => {
    const long = `${SAMPLES.nl} `.repeat(2_000)
    const started = performance.now()
    expect(detectLanguage(long)).toBe('nl')
    expect(performance.now() - started).toBeLessThan(200)
  })
})
