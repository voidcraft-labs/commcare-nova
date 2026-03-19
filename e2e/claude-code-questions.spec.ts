import { test, expect } from '@playwright/test'

/**
 * E2E test: Verify that Claude Code asks questions before generating,
 * and the "Blueprint generated" banner does NOT appear during the question phase.
 *
 * This specifically tests the bug where extractBlueprint was triggering
 * on conversational responses before generation was complete.
 */

test('questions phase does not trigger blueprint banner', async ({ page }) => {
  await page.goto('/build/cc')

  // Send a vague prompt that should trigger questions
  const input = page.locator('textarea[placeholder="Describe the app you want to build..."]')
  await expect(input).toBeVisible()
  await input.fill('I want to build a health app')
  await input.press('Enter')

  // Wait for Claude Code to respond (should ask a question)
  await expect(page.locator('.chat-markdown').first()).toBeVisible({ timeout: 120_000 })
  console.log('First response received')

  // Wait for streaming to finish (input becomes enabled again)
  await expect(input).toBeEnabled({ timeout: 60_000 })
  console.log('Streaming complete — checking for false blueprint detection')

  // The banner should NOT be visible — Claude Code should be asking questions, not generating
  const validateButton = page.locator('button', { hasText: 'Validate' })
  const blueprintBanner = page.locator('text=Blueprint generated')

  // Give a moment for any false detection to trigger
  await page.waitForTimeout(2000)

  const bannerVisible = await blueprintBanner.isVisible()
  const validateVisible = await validateButton.isVisible()

  console.log(`Blueprint banner visible: ${bannerVisible}`)
  console.log(`Validate button visible: ${validateVisible}`)

  // Neither should be visible during the question phase
  expect(bannerVisible).toBe(false)
  expect(validateVisible).toBe(false)

  // Should see either a structured question card or conversational text
  const pageContent = await page.content()
  const hasQuestionContent = /question|what|which|how|who|tell me/i.test(pageContent)
  expect(hasQuestionContent).toBeTruthy()

  console.log('Confirmed: no false blueprint detection during question phase')

  await page.screenshot({ path: 'e2e/screenshots/question-phase-no-banner.png', fullPage: true })
})
