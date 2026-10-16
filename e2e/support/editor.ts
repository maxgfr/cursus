import { expect, type Locator, type Page } from '@playwright/test'

/** Turns « Show the Markdown source » (under the editor's « More options ») on or off. */
export async function showMarkdown(page: Page, editor: Locator, on: boolean) {
  const frame = page.locator('div[class*="frame"]', { has: editor }).last()
  await frame.getByRole('button', { name: 'More options' }).click()
  const toggle = frame.getByRole('switch', { name: 'Show the Markdown source' })
  await expect(toggle).toBeChecked({ checked: !on })
  await toggle.click()
  await expect(toggle).toBeHidden()
}

/** The raw Markdown, line by line, as the source view shows it; the editor is left as it reads. */
export async function sourceText(page: Page, editor: Locator): Promise<string> {
  await showMarkdown(page, editor, true)
  const text = await editor.evaluate((el) => [...el.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n'))
  await showMarkdown(page, editor, false)
  return text
}
