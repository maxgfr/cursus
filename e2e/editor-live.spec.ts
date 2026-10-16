import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { sourceText } from './support/editor.ts'
import { createCourse, isPhone, watchErrors } from './support/page.ts'

// The Markdown editor reads as the renderer draws it while it is written; the stored text stays plain Markdown.

const LARGE = join(import.meta.dirname, 'fixtures', 'large.png')

async function newNote(page: Page, course: string): Promise<Locator> {
  await page.goto('./#/')
  await createCourse(page, course)
  await page.getByRole('radio', { name: 'Sources' }).check()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: 'Write a note' }).click()
  const editor = page.getByRole('textbox', { name: 'Source' })
  await expect(editor).toBeVisible()
  return editor
}

const blur = (editor: Locator) => editor.evaluate((el) => (el as HTMLElement).blur())

/** A new card's editor, in a new course. */
async function newCard(page: Page, course: string) {
  await page.goto('./#/')
  await createCourse(page, course)
  await page.getByRole('radio', { name: 'Cards' }).check()
  await page.getByRole('button', { name: 'New card' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Card' })).toBeVisible()
}

const save = (page: Page) => page.getByRole('button', { name: /^Save( ⌘S| Ctrl\+S)?$/ }).first()

/** Saves the card, then opens it in Review (the answer shown when `answer`). */
async function review(page: Page, phone: boolean, answer: boolean) {
  await save(page).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Card' })).toBeHidden()
  await page.goto('./#/review')
  await expect(page.getByTestId('question')).toBeVisible()
  if (!answer) return
  if (phone) await page.getByRole('button', { name: /Show answer/ }).tap()
  else await page.keyboard.press('Space')
  await expect(page.getByTestId('answer')).toBeVisible()
}

/** Something to find on screen: a piece of text (its first character) or an element. */
type Anchor = { text: string } | { css: string }

/** Where each anchor's box starts, from the top of the viewport. */
function tops(root: Locator, anchors: Anchor[]): Promise<number[]> {
  return root.evaluate((el, list) => {
    return list.map((a) => {
      if ('css' in a) return el.querySelector(a.css)?.getBoundingClientRect().top ?? Number.NaN
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.textContent ?? '').indexOf(a.text)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + 1)
        return r.getBoundingClientRect().top
      }
      return Number.NaN
    })
  }, anchors)
}

/** Each anchor's distance from the first one, rounded. */
const offsets = (xs: number[]) => xs.map((x) => Math.round(x - (xs[0] ?? 0)))

/** The box of `text` (its first occurrence) on screen. */
function textBox(root: Locator, text: string): Promise<{ left: number; right: number; top: number; bottom: number }> {
  return root.evaluate((el, t) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.textContent ?? '').indexOf(t)
      if (i < 0) continue
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + t.length)
      const b = r.getBoundingClientRect()
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }
    }
    throw new Error(`"${t}" is not on screen`)
  }, text)
}

const selected = (page: Page) => page.evaluate(() => document.getSelection()?.toString() ?? '')

test('bold shows as it is typed, its asterisks gone once closed and never back; undo, source view, stored text', async ({
  page,
}) => {
  const errors = watchErrors(page)
  const editor = await newNote(page, 'Live writing')
  await editor.click()

  // Bold from the opening ** on, before it is closed.
  await page.keyboard.type('Plain **bo')
  const strong = editor.locator('.cm-md-strong')
  await expect(strong).toHaveText('bo')
  expect(Number(await strong.evaluate((el) => getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(600)

  // Closed: bold, the asterisks gone from sight.
  await page.keyboard.type('ld** after')
  await expect(strong).toHaveText('bold')
  await expect(editor).toHaveText('Plain bold after')
  // Back on the bold word, as in a word processor: no syntax comes back, the caret steps over the hidden **, and
  // typing at the word's end makes the word longer, still bold.
  for (let i = 0; i < ' after'.length + 1; i++) await page.keyboard.press('ArrowLeft')
  await expect(editor).toHaveText('Plain bold after')
  await page.keyboard.type('er')
  await expect(strong).toHaveText('bolder')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('End')
  await expect(editor).toHaveText('Plain bold after')

  // One more edit (after the undo manager's 500 ms grouping window), then undone.
  await page.waitForTimeout(700)
  await page.keyboard.type(' and *more*')
  await expect(editor.locator('.cm-md-em')).toHaveText('more')
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(editor.locator('.cm-md-em')).toHaveCount(0)
  await expect(editor).toContainText('Plain')
  await expect(editor).not.toContainText('more')

  // The source view shows the raw Markdown; the text stored is exactly what was typed.
  expect(await sourceText(page, editor)).toBe('Plain **bold** after')
  await page.reload()
  await expect(editor).toHaveText('Plain bold after')
  expect(await sourceText(page, editor)).toBe('Plain **bold** after')
  expect(errors).toEqual([])
})

test('a heading, a list and inline maths render in the editor; a tap on the formula edits it in its own field', async ({
  page,
}) => {
  const errors = watchErrors(page)
  const editor = await newNote(page, 'Live blocks')
  await editor.click()
  const markdown = '# Membranes\n\n- lipids\n- proteins\n\nArea $\\pi r^2$ grows.'
  await page.keyboard.insertText(markdown)
  await blur(editor)

  const heading = editor.getByRole('heading', { name: 'Membranes' })
  await expect(heading).toBeVisible()
  await expect(heading).toHaveAttribute('aria-level', '2')
  const size = (l: Locator) => l.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
  expect(await size(heading)).toBeGreaterThan(await size(editor.locator('.cm-line').last()))
  await expect(editor.locator('.cm-md-listMark')).toHaveCount(2)
  await expect(editor.locator('.cm-md-math .katex')).toHaveCount(1)
  await expect(editor).toHaveText(/^Membranes\s*lipids\s*proteins\s*Area .*grows\.$/)
  await expect(editor).not.toContainText('#')
  await expect(editor).not.toContainText('$')

  // A tap on the heading: still no #. A tap on the formula opens its editor, its LaTeX drawn as typed.
  await heading.click()
  await expect(editor).not.toContainText('#')
  await editor.locator('.cm-md-math').click()
  const dialog = page.getByRole('dialog', { name: 'Math' })
  const latex = dialog.getByRole('textbox', { name: 'Formula (LaTeX)' })
  await expect(latex).toHaveValue('\\pi r^2')
  await expect(latex).toBeFocused()
  await latex.fill('\\pi r^3')
  await expect(dialog.locator('.katex')).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(dialog).toBeHidden()
  await expect(editor).not.toContainText('$')
  await expect(editor.locator('.cm-md-math .katex')).toHaveCount(1)

  expect(await sourceText(page, editor)).toBe(markdown.replace('r^2', 'r^3'))
  expect(errors).toEqual([])
})

test('a photo renders in the editor, its reference hidden when the caret is elsewhere', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('./#/')
  await createCourse(page, 'Live photos')
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page.getByRole('link', { name: /^Photos/ }).click()
  const camera = page.getByRole('button', { name: 'Take photo' })
  const add = (await camera.isVisible()) ? camera : page.getByRole('button', { name: 'Add photos' }).first()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), add.click()])
  await chooser.setFiles(LARGE)
  await expect(
    page.getByTestId('photo-tile').filter({ has: page.getByRole('link', { name: /^large$/ }) }),
  ).toHaveAttribute('data-state', 'ready')
  await page.getByRole('link', { name: 'large' }).click()
  await page.getByRole('button', { name: 'New card with this photo' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Card' })).toBeVisible()

  const front = page.getByRole('textbox', { name: 'Front' })
  await page.getByRole('textbox', { name: 'Back' }).click()
  const photo = front.locator('.cm-photoPreview').getByRole('img', { name: 'large' })
  await expect(photo).toBeVisible()
  expect(await photo.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(front).not.toContainText('cursus-blob:')
  expect(await sourceText(page, front)).toMatch(/^!\[large\]\(cursus-blob:[0-9a-f]{64}\)$/)
  expect(errors).toEqual([])
})

test('blocks sit as far apart in the editor as in review; code stands out on the answer', async ({ page }, info) => {
  const errors = watchErrors(page)
  await newCard(page, 'Live spacing')
  const front = page.getByRole('textbox', { name: 'Front' })
  await front.click()
  await page.keyboard.insertText(
    [
      'Intro line',
      '',
      '- First bullet',
      '- Third bullet',
      '',
      '1. First number',
      '2. Second number',
      '',
      '> A quote',
      '',
      '---',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '$$',
      'x^2',
      '$$',
      '',
      '```',
      'const x = 1',
      '```',
      '',
      'End line',
    ].join('\n'),
  )
  const back = page.getByRole('textbox', { name: 'Back' })
  await back.click()
  await page.keyboard.insertText('Answer `inline code`\n\n```\nlet y = 2\n```')
  await blur(back)
  const texts = ['Intro line', 'First bullet', 'Third bullet', 'First number', 'Second number', 'A quote']
  const inEditor = await tops(front, [
    ...texts.map((text) => ({ text })),
    { css: '.cm-md-rule' },
    { css: '.cm-md-table table' },
    { css: '.katex-display' },
    { text: 'const x' },
    { text: 'End line' },
  ])
  await review(page, isPhone(info.project.name), true)
  const question = page.getByTestId('question')
  await expect(question.locator('.katex-display')).toBeVisible()
  const inReview = await tops(question, [
    ...texts.map((text) => ({ text })),
    { css: 'hr' },
    { css: 'table' },
    { css: '.katex-display' },
    { text: 'const x' },
    { text: 'End line' },
  ])
  const editorOffsets = offsets(inEditor)
  const reviewOffsets = offsets(inReview)
  const report = JSON.stringify({ editorOffsets, reviewOffsets })
  for (const [i, at] of editorOffsets.entries()) {
    expect(Math.abs(at - (reviewOffsets[i] ?? Number.NaN)), report).toBeLessThanOrEqual(2)
  }

  // On the answer's pressed surface, inline code and a code block keep a surface of their own.
  const answer = page.getByTestId('answer')
  const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
  const face = await bg(answer)
  expect(await bg(answer.locator('p code'))).not.toBe(face)
  expect(await bg(answer.locator('pre'))).not.toBe(face)
  expect(errors).toEqual([])
})

test('a cloze card marks its deletions as its review does; a basic card prints them as typed', async ({
  page,
}, info) => {
  const errors = watchErrors(page)
  await newCard(page, 'Live cloze')
  const typed = 'The capital of France is {{c1::Paris}}.'
  await page.getByRole('textbox', { name: 'Front' }).click()
  await page.keyboard.insertText(typed)
  await page.getByRole('textbox', { name: 'Back' }).click()
  // A question-and-answer card: the renderer prints the braces, so does the editor.
  const basic = page.getByRole('textbox', { name: 'Front' })
  await expect(basic).toHaveText(typed)
  await expect(basic.locator('.cm-md-cloze')).toHaveCount(0)

  await page.getByRole('radio', { name: 'Fill in the blank' }).check({ force: true })
  const text = page.getByRole('textbox', { name: 'Text' })
  await expect(text.locator('.cm-md-cloze')).toHaveText('Paris')
  await expect(text).toHaveText('The capital of France is Paris.')
  const look = (l: Locator) =>
    l.evaluate((el) => {
      const s = getComputedStyle(el)
      return { color: s.color, background: s.backgroundColor, radius: s.borderTopLeftRadius }
    })
  const chip = await look(text.locator('.cm-md-cloze'))

  await review(page, isPhone(info.project.name), false)
  const asked = page.getByTestId('question').locator('mark.cloze')
  await expect(asked).toHaveText('[...]')
  expect(await look(asked)).toEqual(chip)
  if (isPhone(info.project.name)) await page.getByRole('button', { name: /Show answer/ }).tap()
  else await page.keyboard.press('Space')
  const answered = page.getByTestId('answer').locator('mark.cloze')
  await expect(answered).toHaveText('Paris')
  expect(await look(answered)).toEqual(chip)
  expect(errors).toEqual([])
})

test('a photo sits as far below its paragraph as in review; a photo in a table is drawn', async ({ page }, info) => {
  const errors = watchErrors(page)
  await page.goto('./#/')
  await createCourse(page, 'Live photo gap')
  await page.getByRole('radio', { name: 'Sources' }).check({ force: true })
  await page.getByRole('link', { name: /^Photos/ }).click()
  const camera = page.getByRole('button', { name: 'Take photo' })
  const add = (await camera.isVisible()) ? camera : page.getByRole('button', { name: 'Add photos' }).first()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), add.click()])
  await chooser.setFiles(LARGE)
  await expect(
    page.getByTestId('photo-tile').filter({ has: page.getByRole('link', { name: /^large$/ }) }),
  ).toHaveAttribute('data-state', 'ready')
  await page.getByRole('link', { name: 'large' }).click()
  await page.getByRole('button', { name: 'New card with this photo' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Card' })).toBeVisible()
  const ref = await sourceText(page, page.getByRole('textbox', { name: 'Front' }))

  const back = page.getByRole('textbox', { name: 'Back' })
  await back.click()
  await page.keyboard.insertText(`The capital\n\n${ref}\n\n| p |\n|---|\n| ${ref} |`)
  await blur(back)
  const inTable = back.locator('.cm-md-table img')
  await expect(inTable).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => inTable.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  const photo = back.locator('.cm-photoPreview img')
  await expect.poll(() => photo.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  const inEditor = offsets(await tops(back, [{ text: 'The capital' }, { css: '.cm-photoPreview img' }]))

  await review(page, isPhone(info.project.name), true)
  const shown = page.getByTestId('answer').locator('p img')
  await expect.poll(() => shown.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  const inReview = offsets(await tops(page.getByTestId('answer'), [{ text: 'The capital' }, { css: 'p img' }]))
  const report = JSON.stringify({ inEditor, inReview })
  expect(Math.abs((inEditor[1] ?? 0) - (inReview[1] ?? 0)), report).toBeLessThanOrEqual(2)
  expect(errors).toEqual([])
})

test('a double click selects the drawn word; a drag ends where it is released', async ({ page }) => {
  const errors = watchErrors(page)
  const editor = await newNote(page, 'Live pointer')
  await editor.click()
  await page.keyboard.insertText('Use **as** a verb, *or* not, `fn` here, and [go](https://e.com) on.')
  for (const word of ['as', 'or', 'fn', 'go']) {
    await blur(editor)
    await expect(editor).toHaveText('Use as a verb, or not, fn here, and go on.')
    const box = await textBox(editor, word)
    await page.mouse.dblclick((box.left + box.right) / 2, (box.top + box.bottom) / 2)
    await expect.poll(() => selected(page), word).toBe(word)
  }

  const url = `https://example.com/${'long-path-segment/'.repeat(7)}end`
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(
    `Intro [the link](${url}) end\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSecond paragraph with target word`,
  )
  await blur(editor)
  await expect(editor.locator('.cm-md-table')).toHaveCount(1)
  const from = await textBox(editor, 'Intro')
  const to = await textBox(editor, 'target')
  await page.mouse.move(from.left + 1, (from.top + from.bottom) / 2)
  await page.mouse.down()
  await page.mouse.move((from.left + to.right) / 2, (from.top + to.bottom) / 2, { steps: 5 })
  await page.mouse.move(to.right, (to.top + to.bottom) / 2, { steps: 5 })
  await page.mouse.up()
  // Neither the link's address nor the table's source shows; the selection stays where it was released.
  await expect(editor).not.toContainText(url)
  await expect(editor).not.toContainText('|---|')
  await expect.poll(() => selected(page)).toMatch(/^Intro[\s\S]*target$/)
  expect(errors).toEqual([])
})

test('arrows go past a drawn table or formula; a tap on one edits it in its own editor', async ({ page }) => {
  const errors = watchErrors(page)
  const editor = await newNote(page, 'Live arrows')
  await editor.click()
  await page.keyboard.insertText('before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n\n$$\nx^2\n$$\n\nend')
  await blur(editor)
  const table = editor.locator('.cm-md-table')
  const formula = editor.locator('.katex-display')
  await expect(table).toHaveCount(1)
  await expect(formula).toHaveCount(1)

  // The caret moves through the text; the table and the formula stay drawn, their source never shown.
  await editor.getByText('before').click()
  await page.keyboard.press('End')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
  await expect(table).toHaveCount(1)
  await expect(formula).toHaveCount(1)
  await expect(editor).not.toContainText('| a | b |')
  await expect(editor).not.toContainText('$$')

  // The table as a grid of cells.
  await table.locator('td').first().click()
  const grid = page.getByRole('dialog', { name: 'Table' })
  const cell = grid.getByRole('textbox', { name: 'Row 2, column 1' })
  await expect(cell).toHaveValue('1')
  await cell.fill('Z1')
  await grid.getByRole('button', { name: 'Add a row' }).click()
  await grid.getByRole('textbox', { name: 'Row 3, column 2' }).fill('4')
  await grid.getByRole('button', { name: 'Apply' }).click()
  await expect(grid).toBeHidden()
  await expect(table.locator('td')).toHaveText(['Z1', '2', '', '4'])

  // The formula in its field; Escape leaves it as it was.
  await formula.click()
  const math = page.getByRole('dialog', { name: 'Math' })
  await expect(math.getByRole('textbox', { name: 'Formula (LaTeX)' })).toHaveValue('x^2')
  await page.keyboard.press('Escape')
  await expect(math).toBeHidden()

  const stored = await sourceText(page, editor)
  expect(stored).toContain('| a | b |\n| --- | --- |\n| Z1 | 2 |\n|  | 4 |')
  expect(stored).toContain('$$\nx^2\n$$')
  expect(errors).toEqual([])
})

test('toolbar: Bold toggles, Heading and List take what is typed next; stars that open nothing stay plain', async ({
  page,
}) => {
  const errors = watchErrors(page)
  const editor = await newNote(page, 'Live toolbar')
  await editor.click()
  await page.keyboard.type('word')
  await page.keyboard.press('Shift+Home')
  const button = (name: string) => page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name })
  await button('Bold').click()
  await expect(editor.locator('.cm-md-strong')).toHaveText('word')
  await expect(button('Bold')).toHaveAttribute('aria-pressed', 'true')
  await button('Bold').click()
  await expect(editor.locator('.cm-md-strong')).toHaveCount(0)
  await expect(editor).toHaveText('word')

  await page.keyboard.press('End')
  await page.keyboard.type(' 2*3=6')
  await expect(editor.locator('.cm-md-em')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await button('Heading 2').click()
  await page.keyboard.type('Title')
  await expect(button('Heading 2')).toHaveAttribute('aria-pressed', 'true')
  await expect(editor.getByRole('heading', { name: 'Title' })).toBeVisible()
  await page.keyboard.press('Enter')
  await button('Bulleted list').click()
  await page.keyboard.type('item')
  expect(await sourceText(page, editor)).toBe('word 2*3=6\n## Title\n- item')
  expect(errors).toEqual([])
})

test('a task checkbox is named after its task and ticks with Alt+Enter; an item continues under its text', async ({
  page,
}) => {
  const errors = watchErrors(page)
  const editor = await newNote(page, 'Live tasks')
  await editor.click()
  await page.keyboard.insertText('- [ ] buy milk\n- one\n  two continues\n- three')
  await blur(editor)
  const task = editor.getByRole('checkbox', { name: 'Done: buy milk' })
  await expect(task).not.toBeChecked()
  await expect(task).toHaveAttribute('aria-keyshortcuts', 'Alt+Enter')
  const one = await textBox(editor, 'one')
  const two = await textBox(editor, 'two continues')
  expect(Math.abs(two.left - one.left)).toBeLessThanOrEqual(1)

  await editor.getByText('buy milk').click()
  await page.keyboard.press('Alt+Enter')
  await expect(task).toBeChecked()
  expect(await sourceText(page, editor)).toBe('- [x] buy milk\n- one\n  two continues\n- three')
  expect(errors).toEqual([])
})
