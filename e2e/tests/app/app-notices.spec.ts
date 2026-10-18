import { expect, seedFor, test } from "../../lib/appFixtures";
import { APP_NOTICES_SEED } from "../../lib/appNoticesSeed";

test("a migration notice is reviewed and dismissed for good, and the saved-key line dismisses on its own", {
	tag: "@seed:app-notices",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "app-notices");
	const fixture = seed.appNotices;
	const chip = page.getByRole("button", {
		name: "1 update to review",
		exact: true,
	});

	await test.step("the chip opens the dialog, which lists the notice's lines", async () => {
		await page.goto(fixture.route);
		await expect(chip).toBeVisible({ timeout: 20_000 });
		await chip.click();
		const dialog = page.getByRole("dialog", {
			name: "What changed in this app",
		});
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByText(
				/^Nova changed how it writes apps for CommCare HQ on .+\. Here is what that means for this app\.$/,
			),
		).toBeVisible();
		await expect(
			dialog.getByRole("heading", {
				name: `At the next publish to ${APP_NOTICES_SEED.domain}`,
			}),
		).toBeVisible();
		await expect(
			dialog.getByText(APP_NOTICES_SEED.deepLinksLine, { exact: true }),
		).toBeVisible();
		await expect(
			dialog.getByText(APP_NOTICES_SEED.discardedLine, { exact: true }),
		).toBeVisible();

		// The dialog closes, and the chip goes, once the server has recorded the dismissal.
		await dialog.getByRole("button", { name: "Got it", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(chip).toBeHidden();
	});

	await test.step("the dismissal holds through a reload", async () => {
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Publish", exact: true }),
		).toBeVisible({ timeout: 20_000 });
		await expect(chip).toHaveCount(0);
	});

	await test.step("the home page's saved-key line dismisses apart from the app's notice", async () => {
		await page.goto("/");
		const line = page.getByRole("status").filter({
			hasText: `Nova read ${APP_NOTICES_SEED.domain} on CommCare HQ with your saved key`,
		});
		await expect(line).toBeVisible({ timeout: 20_000 });
		await expect(line).toContainText(
			"to keep its apps' IDs steady through an update.",
		);
		await line.getByRole("button", { name: "Got it", exact: true }).click();
		await expect(line).toBeHidden();
		await page.reload();
		// Wait for this app's visible card; a streamed, hidden copy can still
		// carry the same href while the page commits after the reload.
		await expect(
			page.locator(`a[href="${fixture.route}"]`).visible(),
		).toBeVisible({
			timeout: 20_000,
		});
		await expect(line).toHaveCount(0);
	});
});
