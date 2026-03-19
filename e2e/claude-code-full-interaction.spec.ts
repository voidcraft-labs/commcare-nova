import { test, expect } from '@playwright/test'

/**
 * Full interaction test: generate app via Claude Code, open in builder,
 * then click through modules/forms/questions to verify nothing crashes.
 */

test('generate, validate, open builder, interact with tree', async ({ page }) => {
  // Catch any page errors
  const pageErrors: string[] = []
  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
    console.log('PAGE ERROR:', err.message)
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text())
  })

  await page.goto('/build/cc')

  const input = page.locator('textarea[placeholder="Describe the app you want to build..."]')
  await expect(input).toBeVisible()

  await input.fill(
    'Build a simple patient tracker. Track patients with full_name (text, case name), age (int), ' +
    'village (text), risk_level (select1: low/medium/high). ' +
    'One module "Patients" with case_type patient. ' +
    'Registration form "Register Patient" with all 4 fields. ' +
    'Followup form "Update Patient" that preloads and updates risk_level. ' +
    'Generate immediately, no questions needed.'
  )
  await input.press('Enter')

  // Wait for blueprint
  console.log('Waiting for blueprint generation...')
  const validateBtn = page.locator('button', { hasText: 'Validate' })
  await expect(validateBtn).toBeVisible({ timeout: 4 * 60 * 1000 })
  console.log('Blueprint generated')

  // Validate
  await validateBtn.click()
  const openBtn = page.locator('button', { hasText: 'Open in Builder' })
  await expect(openBtn).toBeVisible({ timeout: 4 * 60 * 1000 })
  console.log('Validation passed')

  // Open in builder
  await openBtn.click()
  await page.waitForTimeout(2000)

  // Verify we're in the builder
  await expect(page.locator('text=View mode')).toBeVisible({ timeout: 5000 })
  console.log('Builder loaded')

  // Take initial screenshot
  await page.screenshot({ path: 'e2e/screenshots/interaction-01-builder.png' })

  // Click on the first module in the tree
  const moduleItem = page.locator('text=Patients').first()
  if (await moduleItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    await moduleItem.click()
    await page.waitForTimeout(500)
    console.log('Clicked Patients module')
    await page.screenshot({ path: 'e2e/screenshots/interaction-02-module.png' })
  }

  // Click on Register Patient form
  const regForm = page.locator('text=Register Patient').first()
  if (await regForm.isVisible({ timeout: 3000 }).catch(() => false)) {
    await regForm.click()
    await page.waitForTimeout(500)
    console.log('Clicked Register Patient form')
    await page.screenshot({ path: 'e2e/screenshots/interaction-03-reg-form.png' })
  }

  // Click on a question in the tree
  const nameQuestion = page.locator('text=full_name').or(page.locator('text=Full Name')).first()
  if (await nameQuestion.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nameQuestion.click()
    await page.waitForTimeout(500)
    console.log('Clicked name question')
    await page.screenshot({ path: 'e2e/screenshots/interaction-04-question.png' })
  }

  // Click on Update Patient form
  const updateForm = page.locator('text=Update Patient').first()
  if (await updateForm.isVisible({ timeout: 3000 }).catch(() => false)) {
    await updateForm.click()
    await page.waitForTimeout(500)
    console.log('Clicked Update Patient form')
    await page.screenshot({ path: 'e2e/screenshots/interaction-05-update-form.png' })
  }

  // Try switching view modes
  const designBtn = page.locator('button', { hasText: 'Design' }).or(page.locator('text=Design'))
  if (await designBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await designBtn.first().click()
    await page.waitForTimeout(1000)
    console.log('Switched to Design view')
    await page.screenshot({ path: 'e2e/screenshots/interaction-06-design.png' })
  }

  const previewBtn = page.locator('button', { hasText: 'Preview' }).or(page.locator('text=Preview'))
  if (await previewBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await previewBtn.first().click()
    await page.waitForTimeout(1000)
    console.log('Switched to Preview view')
    await page.screenshot({ path: 'e2e/screenshots/interaction-07-preview.png' })
  }

  // Back to tree
  const treeBtn = page.locator('button', { hasText: 'Tree' }).or(page.locator('text=Tree'))
  if (await treeBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await treeBtn.first().click()
    await page.waitForTimeout(500)
    console.log('Switched back to Tree view')
  }

  // Final screenshot
  await page.screenshot({ path: 'e2e/screenshots/interaction-08-final.png', fullPage: true })

  // Check for any page errors that occurred during interaction
  if (pageErrors.length > 0) {
    console.log(`\nPage errors encountered:\n${pageErrors.join('\n')}`)
  }
  expect(pageErrors).toHaveLength(0)

  console.log('Full interaction test passed — no crashes!')
})
