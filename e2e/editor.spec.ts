import { expect, type Locator, type Page, test } from '@playwright/test'
import { showMarkdown, sourceText } from './support/editor.ts'
import { createCourse, seriousViolations, watchErrors } from './support/page.ts'

// The editor writes like a word processor: its Markdown never shows (unless asked for), and what is stored is
// plain Markdown.

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

const text = (editor: Locator) => editor.evaluate((el) => el.textContent ?? '')

test('a heading, bold, a list item and a link: no Markdown on screen, wherever the caret goes; plain Markdown stored', async ({
  page,
}) => {
  const errors = watchErrors(page)
  const editor = await newNote(page, 'Word processor')
  await editor.click()
  await page.keyboard.type('# Titre')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('**gras**')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- item')
  // Enter continues the list; Enter on the empty item leaves it.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  // A link from the keyboard, with the shortcut its button announces (⌘K on an iPhone or an iPad, whatever the
  // machine running the test): its text and address in its card.
  const shortcut = await page.getByRole('button', { name: 'Link', exact: true }).getAttribute('aria-keyshortcuts')
  expect(shortcut).toMatch(/^(Meta|Control)\+K$/)
  await page.keyboard.press(`${shortcut?.split('+')[0]}+k`)
  const card = page.getByRole('dialog', { name: 'Link' })
  await card.getByRole('textbox', { name: 'Text' }).fill('x')
  await card.getByRole('textbox', { name: 'Address' }).fill('https://example.com/page')
  await card.getByRole('button', { name: 'Apply' }).click()
  await expect(card).toBeHidden()

  const shown = editor.getByRole('heading', { name: 'Titre' })
  await expect(shown).toBeVisible()
  await expect(editor.locator('.cm-md-strong')).toHaveText('gras')
  await expect(editor.locator('.cm-md-listMark')).toHaveCount(1)
  await expect(editor.locator('.cm-md-link')).toHaveText('x')
  // A tap on each: the text stays as it reads.
  for (const target of [
    shown,
    editor.getByText('gras'),
    editor.getByText('item'),
    editor.getByText('x', { exact: true }),
  ]) {
    await target.click()
    const now = await text(editor)
    expect(now).not.toMatch(/#|\*\*|^- |example\.com/)
    expect(now).not.toContain('- item')
  }
  // The tap on the link shows its card, the focus left in the text.
  await expect(card.getByRole('link', { name: 'Open the link' })).toHaveAttribute('href', 'https://example.com/page')
  await expect(editor).toBeFocused()
  expect(await seriousViolations(page)).toEqual([])
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()

  expect(await sourceText(page, editor)).toBe('# Titre\n\n**gras**\n\n- item\n\n[x](https://example.com/page)')
  expect(errors).toEqual([])
})

test('typed shortcuts: a heading, a quote, a task from [ ]; Backspace takes the formatting off; undo and redo', async ({
  page,
}) => {
  const errors = watchErrors(page)
  const editor = await newNote(page, 'Typing rules')
  await editor.click()
  await page.keyboard.type('## Part')
  await expect(editor.getByRole('heading', { name: 'Part' })).toBeVisible()
  await page.keyboard.press('Home')
  // At the heading's start (after its hidden ##), Backspace makes it text again.
  await page.keyboard.press('Backspace')
  await expect(editor.getByRole('heading')).toHaveCount(0)
  await expect(editor).toHaveText('Part')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('[] milk')
  await expect(editor.getByRole('checkbox', { name: 'Done: milk' })).toBeVisible()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('> said')
  await expect(editor.locator('.cm-md-quote')).toHaveCount(1)
  expect(await text(editor)).not.toContain('>')
  expect(await sourceText(page, editor)).toBe('Part\n\n- [ ] milk\n\n> said')

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(editor.locator('.cm-md-quote')).toHaveCount(0)
  await page.getByRole('button', { name: 'Redo' }).click()
  await expect(editor.locator('.cm-md-quote')).toHaveCount(1)
  expect(errors).toEqual([])
})

test('formatted text pasted from a page arrives as Markdown; « Show Markdown » is remembered on this device', async ({
  page,
}) => {
  const errors = watchErrors(page)
  const editor = await newNote(page, 'Pasting')
  await editor.click()
  await editor.evaluate((el) => {
    const data = new DataTransfer()
    data.setData(
      'text/html',
      '<p>Some <strong>bold</strong> and <em>it</em>, see <a href="https://e.com">this</a>.</p>',
    )
    data.setData('text/plain', 'Some bold and it, see this.')
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(editor.locator('.cm-md-strong')).toHaveText('bold')
  await expect(editor).toHaveText('Some bold and it, see this.')

  await showMarkdown(page, editor, true)
  await expect(editor).toHaveText('Some **bold** and *it*, see [this](https://e.com).')
  // The formatting buttons wait while the Markdown is shown.
  await expect(page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bold' })).toBeDisabled()
  await page.reload()
  await expect(editor).toHaveText('Some **bold** and *it*, see [this](https://e.com).')
  await showMarkdown(page, editor, false)
  await expect(editor).toHaveText('Some bold and it, see this.')
  expect(errors).toEqual([])
})

test('the toolbar: buttons show what is in effect, tables and formulas are added from it', async ({ page }) => {
  const errors = watchErrors(page)
  const editor = await newNote(page, 'Toolbar')
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' })
  const button = (name: string) => toolbar.getByRole('button', { name, exact: true })
  await editor.click()
  await page.keyboard.type('Intro')
  await button('Numbered list').click()
  await expect(button('Numbered list')).toHaveAttribute('aria-pressed', 'true')
  await button('Checklist').click()
  await expect(button('Checklist')).toHaveAttribute('aria-pressed', 'true')
  await expect(button('Numbered list')).toHaveAttribute('aria-pressed', 'false')
  await button('Checklist').click()
  await button('Quote').click()
  await expect(button('Quote')).toHaveAttribute('aria-pressed', 'true')
  await button('Quote').click()

  await button('Math').click()
  const math = page.getByRole('dialog', { name: 'Math' })
  await math.getByRole('textbox', { name: 'Formula (LaTeX)' }).fill('E = mc^2')
  await math.getByRole('button', { name: 'Apply' }).click()
  await expect(editor.locator('.cm-md-math .katex')).toHaveCount(1)

  await button('Table').click()
  const table = page.getByRole('dialog', { name: 'Table' })
  await table.getByRole('textbox', { name: 'Row 2, column 1' }).fill('a')
  await table.getByRole('textbox', { name: 'Row 2, column 2' }).fill('b')
  expect(await seriousViolations(page)).toEqual([])
  await table.getByRole('button', { name: 'Apply' }).click()
  await expect(editor.locator('.cm-md-table td')).toHaveText(['a', 'b'])
  expect(await sourceText(page, editor)).toBe('Intro$E = mc^2$\n\n| Column 1 | Column 2 |\n| --- | --- |\n| a | b |')
  expect(errors).toEqual([])
})
