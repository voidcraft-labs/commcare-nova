import { test, expect } from '@playwright/test'

/**
 * E2E test: Send a semi-detailed prompt, handle 0-2 questions if asked,
 * then validate and open in builder. Proves the full interactive flow works
 * regardless of whether Claude Code asks questions or generates directly.
 */

test('question → answer → generate → validate → open in builder', async ({ page }) => {
  await page.goto('/build/cc')

  const input = page.locator('textarea[placeholder="Describe the app you want to build..."]')
  await expect(input).toBeVisible()

  await input.fill(
    'Build a patient registration app. Track patients with full_name, age, phone_number, village. ' +
    'One module, one registration form, one followup form for updates. ' +
    'Keep it minimal. Ask at most 1 quick question then generate.'
  )
  await input.press('Enter')

  // Wait for first response
  await expect(page.locator('.chat-markdown').first()).toBeVisible({ timeout: 120_000 })
  await expect(input).toBeEnabled({ timeout: 60_000 })

  // If Claude Code asked a question (no validate button yet), answer it
  const validateBtn = page.locator('button', { hasText: 'Validate' })
  if (!(await validateBtn.isVisible({ timeout: 2000 }).catch(() => false))) {
    // Try clicking a structured option, or type an answer
    const optionButton = page.locator('button:has-text("Keep it simple")').or(
      page.locator('[class*="border-nova-border"][class*="bg-nova-surface"]').first()
    )
    if (await optionButton.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await optionButton.first().click()
    } else {
      await input.fill('Just generate it with sensible defaults.')
      await input.press('Enter')
    }
  }

  // Wait for validate button
  await expect(validateBtn).toBeVisible({ timeout: 4 * 60 * 1000 })
  await validateBtn.click()

  // Wait for validation to pass
  const openBtn = page.locator('button', { hasText: 'Open in Builder' })
  await expect(openBtn).toBeVisible({ timeout: 4 * 60 * 1000 })
  await openBtn.click()

  await page.waitForTimeout(1000)
  await expect(page.locator('text=View mode')).toBeVisible({ timeout: 5000 })

  const content = await page.content()
  expect(/patient/i.test(content)).toBeTruthy()

  await page.screenshot({ path: 'e2e/screenshots/question-flow-builder.png', fullPage: true })
})
