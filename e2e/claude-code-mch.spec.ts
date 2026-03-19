import { test, expect } from '@playwright/test'

/**
 * E2E test: Generate a Maternal & Child Health app via Claude Code mode.
 *
 * Flow:
 * 1. Landing page → toggle to "Claude Code" mode → navigate to /build/cc
 * 2. Send a detailed MCH prompt (skip the question flow for speed)
 * 3. Wait for blueprint generation
 * 4. Click "Validate" → validation runs, fix loop if needed
 * 5. Click "Open in Builder" after validation passes
 * 6. Verify the builder loaded the app correctly
 */

test('generate MCH app via Claude Code with validation', async ({ page }) => {
  // Monitor API responses
  page.on('response', async (response) => {
    if (response.url().includes('/api/claude-code')) {
      console.log(`API response: ${response.status()} ${response.url()}`)
    }
  })

  // ── Step 1: Landing page → Claude Code mode ─────────────────────────

  await page.goto('/')
  await expect(page.locator('text=Build CommCare apps from conversation')).toBeVisible()

  const ccToggle = page.locator('button', { hasText: 'Claude Code' })
  await ccToggle.click()

  const startButton = page.locator('button', { hasText: 'Start with Claude Code' })
  await expect(startButton).toBeVisible()
  await startButton.click()
  await expect(page).toHaveURL('/build/cc')

  // ── Step 2: Send detailed prompt ────────────────────────────────────

  const prompt = `Build a Maternal and Child Health (MCH) tracking app with these requirements:

- Track mothers (pregnant women) with: full_name, age, phone_number, village, expected_delivery_date, risk_level (high/medium/low)
- Track pregnancy visits as child cases of mothers with: trimester, last_visit_date, blood_pressure, weight_kg, notes
- Mother module: registration form to enroll a new mother, followup form for routine checkups that creates a pregnancy visit child case
- Pregnancy Visits module: followup form to view/update visit details
- Keep it simple — 3-6 questions per form
- Make sure every registration form has exactly one is_case_name question
- Make sure every select question has at least 2 options`

  const input = page.locator('textarea[placeholder="Describe the app you want to build..."]')
  await expect(input).toBeVisible()
  await input.fill(prompt)
  await input.press('Enter')

  // ── Step 3: Wait for blueprint generation ───────────────────────────

  // Wait for streaming to start
  await expect(page.locator('.chat-markdown').first()).toBeVisible({ timeout: 120_000 })
  console.log('Streaming started...')

  // Wait for the "Validate" button to appear (blueprint detected, streaming done)
  const validateButton = page.locator('button', { hasText: 'Validate' })
  await expect(validateButton).toBeVisible({ timeout: 4 * 60 * 1000 })
  console.log('Blueprint generated — validate button visible')

  // ── Step 4: Click Validate ──────────────────────────────────────────

  await validateButton.click()
  console.log('Clicked Validate')

  // Wait for either:
  // a) "Validation passed" → we're done
  // b) "validation errors — fixing..." → Claude Code is fixing, wait for next round
  // The component auto-validates after each fix, so we just wait for "passed"

  const passedText = page.locator('text=Validation passed')
  const openButton = page.locator('button', { hasText: 'Open in Builder' })

  // Allow up to 3 fix cycles (each ~30-60s)
  await expect(openButton).toBeVisible({ timeout: 4 * 60 * 1000 })
  await expect(passedText).toBeVisible()
  console.log('Validation passed!')

  // ── Step 5: Open in Builder ─────────────────────────────────────────

  await openButton.click()
  console.log('Clicked Open in Builder')

  // Give builder time to transition
  await page.waitForTimeout(1000)

  // ── Step 6: Verify builder loaded correctly ─────────────────────────

  // View-only banner should show (no API key)
  await expect(page.locator('text=View mode')).toBeVisible({ timeout: 5000 })

  // The app tree should have MCH-related content
  const pageContent = await page.content()
  const hasMaternalContent = /mother|maternal|pregnan/i.test(pageContent)
  expect(hasMaternalContent).toBeTruthy()

  // Should have module and form structure visible
  const hasModules = /case:/i.test(pageContent)
  expect(hasModules).toBeTruthy()

  // Take a screenshot
  await page.screenshot({ path: 'e2e/screenshots/mch-validated-builder.png', fullPage: true })

  console.log('MCH app generated, validated, and loaded into builder successfully!')
})
