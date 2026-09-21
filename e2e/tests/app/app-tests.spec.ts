import { expect, seedFor, test } from "../../lib/appFixtures";

test("opens retained journey observations and switches the ordinary Preview identity", {
	tag: "@seed:app-tests",
}, async ({ scenario, page }) => {
	const { appId } = seedFor(scenario, "app-tests");
	await page.goto(`/build/${appId}`);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const identity = page.getByRole("button", { name: /Running as/ });
	await identity.click();
	await page
		.getByRole("menuitem", { name: "Test journeys", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: "Test journeys" });
	await expect(dialog).toBeVisible();
	await dialog
		.getByRole("button", { name: /Reach visit collection as the saved worker/ })
		.click();
	await expect(dialog).toContainText("Recorded step 0 of 3");
	await expect(dialog).toContainText("Not available to this worker");
	await test.info().attach("recorded-entry", {
		body: await dialog.screenshot(),
		contentType: "image/png",
	});
	await dialog.getByRole("button", { name: "Next step" }).click();
	await expect(dialog).toContainText("Preview as Visit worker");
	await expect(dialog).not.toContainText("Not available to this worker");
	await dialog.getByRole("button", { name: "Next step" }).click();
	await expect(dialog).toContainText("Record visit");
	await dialog.getByRole("button", { name: "Next step" }).click();
	await expect(dialog).toContainText("Test records discarded");
	await expect(
		dialog.getByRole("button", { name: "Next step" }),
	).toBeDisabled();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	// Reading a recorded identity must not impersonate that worker in Preview.
	await expect(identity).toHaveAccessibleName(/Running as Preview as me/);
	await identity.click();
	await page
		.getByRole("menuitemradio", {
			name: "Preview as Visit worker",
			exact: true,
		})
		.click();
	await expect(identity).toHaveAccessibleName(/Running as Visit worker/);
	const main = page.locator("main");
	await main.getByRole("button", { name: /^Visits\b/ }).click();
	await main.getByRole("button", { name: /^Record visit\b/ }).click();
	await expect(main.getByLabel("Visit note")).toBeVisible();
	await main.getByLabel("Visit note").fill("A visible worker journey");
	await test.info().attach("worker-form", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});
