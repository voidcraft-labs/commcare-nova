import { test, expect } from '@playwright/test'

/**
 * E2E test: Generate an app via Claude Code, open in builder,
 * then edit it via the Claude Code chat sidebar (no API key needed).
 */

test('generate app, open builder, edit via Claude Code chat', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
    console.log('PAGE ERROR:', err.message)
  })

  await page.goto('/build/cc')

  const input = page.locator('textarea[placeholder="Describe the app you want to build..."]')
  await expect(input).toBeVisible()

  // Generate a simple app
  await input.fill(
    'Build a simple patient tracker. Patients have full_name (text, case name), age (int), ' +
    'risk_level (select1: low/medium/high). One module, one registration form, one followup form. ' +
    'Generate immediately.'
  )
  await input.press('Enter')

  // Wait for validate → pass → open
  const validateBtn = page.locator('button', { hasText: 'Validate' })
  await expect(validateBtn).toBeVisible({ timeout: 4 * 60 * 1000 })
  await validateBtn.click()

  const openBtn = page.locator('button', { hasText: 'Open in Builder' })
  await expect(openBtn).toBeVisible({ timeout: 4 * 60 * 1000 })
  await openBtn.click()
  await page.waitForTimeout(2000)

  console.log('Builder loaded — checking chat sidebar is available')

  // Chat sidebar should be visible (CC mode with session)
  // Look for the chat input in the sidebar
  const chatInput = page.locator('textarea, input').filter({ hasText: '' }).last()

  // Open chat if collapsed — look for the chat toggle button
  const chatToggle = page.locator('button[title="Open chat"]')
  if (await chatToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
    await chatToggle.click()
    await page.waitForTimeout(500)
  }

  // Find the chat input in the sidebar
  const sidebarInput = page.locator('input[placeholder], textarea[placeholder]').last()
  await expect(sidebarInput).toBeVisible({ timeout: 5000 })
  console.log('Chat sidebar visible')

  // Send an edit request
  await sidebarInput.fill('Add a "phone_number" question with type phone to the registration form')
  await sidebarInput.press('Enter')
  console.log('Sent edit request')

  // Wait for response — the chat should show streaming then settle
  await page.waitForTimeout(30_000) // Claude Code takes time

  // Check the page content for phone_number
  const content = await page.content()
  const hasPhone = /phone/i.test(content)
  console.log(`Phone content found: ${hasPhone}`)

  await page.screenshot({ path: 'e2e/screenshots/edit-via-cc.png', fullPage: true })

  expect(pageErrors).toHaveLength(0)
  console.log('Edit test complete — no crashes')
})
