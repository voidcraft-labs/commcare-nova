import { test, expect } from '@playwright/test'

/**
 * E2E test: Generate a Maternal & Child Health app via Claude Code mode.
 *
 * Flow:
 * 1. Landing page → toggle to "Claude Code" mode → navigate to /build/cc
 * 2. Send a prompt describing an MCH app
 * 3. Wait for Claude Code to generate and return a blueprint
 * 4. Click "Open in Builder" to transition into the visual builder
 * 5. Verify the builder loaded the app with expected modules/forms
 *
 * Requires:
 * - Dev server running on localhost:3000
 * - `claude` CLI installed and authenticated (uses local subscription)
 */

test('generate MCH app via Claude Code and load into builder', async ({ page }) => {
  // ── Step 1: Landing page → Claude Code mode ─────────────────────────

  await page.goto('/')
  await expect(page.locator('text=Build CommCare apps from conversation')).toBeVisible()

  // Toggle to Claude Code mode
  const ccToggle = page.locator('button', { hasText: 'Claude Code' })
  await ccToggle.click()

  // Click "Start with Claude Code"
  const startButton = page.locator('button', { hasText: 'Start with Claude Code' })
  await expect(startButton).toBeVisible()
  await startButton.click()

  // Should navigate to /build/cc
  await expect(page).toHaveURL('/build/cc')

  // ── Step 2: Send prompt ─────────────────────────────────────────────

  const prompt = `Build a Maternal and Child Health (MCH) tracking app with these requirements:

- Track mothers (pregnant women) with: full_name, age, phone_number, village, expected_delivery_date, risk_level (high/medium/low)
- Track pregnancies as child cases of mothers with: trimester, last_visit_date, blood_pressure, weight_kg, notes
- Mother module: registration form to enroll a new mother, followup form for routine checkups that creates a pregnancy visit child case
- Pregnancy module: followup form to view visit history
- Keep it simple — 3-5 questions per form`

  const input = page.locator('textarea[placeholder="Describe the app you want to build..."]')
  await expect(input).toBeVisible()
  await input.fill(prompt)
  await input.press('Enter')

  // ── Step 3: Wait for generation ─────────────────────────────────────

  // Should see streaming response
  await expect(page.locator('.chat-markdown').first()).toBeVisible({ timeout: 30_000 })

  // Wait for the "Blueprint ready" banner — this is the signal that Claude Code
  // finished generating and the blueprint was detected.
  // This can take 1-4 minutes depending on Claude Code's response time.
  const blueprintBanner = page.locator('text=Blueprint ready')
  await expect(blueprintBanner).toBeVisible({ timeout: 4 * 60 * 1000 })

  // ── Step 4: Load into builder ───────────────────────────────────────

  const openButton = page.locator('button', { hasText: 'Open in Builder' })
  await expect(openButton).toBeVisible()
  await openButton.click()

  // ── Step 5: Verify builder loaded ───────────────────────────────────

  // The builder should now be showing the app tree.
  // Wait for the app tree to render with module names.
  // We check for common MCH-related module names that Claude Code should generate.

  // Give the builder a moment to transition
  await page.waitForTimeout(1000)

  // The view-only banner should be visible (no API key)
  await expect(page.locator('text=View mode')).toBeVisible({ timeout: 5000 })

  // Check that the app tree has loaded with at least one module
  // The tree renders module names — look for something MCH-related
  const treeContent = await page.locator('[class*="overflow"]').first().textContent()
  console.log('Builder tree content:', treeContent?.slice(0, 500))

  // Verify we have modules rendered in the tree
  // The exact names depend on what Claude Code generates, but we should see
  // "mother" or "Mother" or "Maternal" somewhere in the tree
  const pageContent = await page.content()
  const hasMaternalContent = /mother|maternal|pregnan/i.test(pageContent)
  expect(hasMaternalContent).toBeTruthy()

  // Take a screenshot for manual review
  await page.screenshot({ path: 'e2e/screenshots/mch-app-builder.png', fullPage: true })

  console.log('MCH app generated and loaded into builder successfully!')
})
