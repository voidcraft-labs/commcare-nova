import { expect, seedFor, test } from "../../lib/appFixtures";

test("opens retained journey observations and switches the ordinary Preview identity", {
	tag: "@seed:app-tests",
}, async ({ scenario, page }) => {
	const { appId } = seedFor(scenario, "app-tests");
	await page.goto(`/build/${appId}`);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const identity = page.getByRole("button", { name: /Running as/ });
	const setup = page.getByRole("region", { name: "Preview identity setup" });
	await expect(setup).toContainText("Preview with a worker identity");
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
	await expect(dialog).not.toContainText("The app has changed");
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
			name: "Preview as Visit worker No place assigned",
			exact: true,
		})
		.click();
	await expect(identity).toHaveAccessibleName(/Running as Visit worker/);
	await expect(setup).toContainText("Visit worker has no place assigned");
	await expect(setup).toContainText("Live Preview uses real app data");
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("Expected the smoke viewport");
	try {
		await page.setViewportSize({ width: 320, height: 820 });
		await expect(
			setup.getByRole("button", { name: "Identity setup", exact: true }),
		).toBeVisible();
		await expect
			.poll(async () => {
				const home = await page
					.locator('[data-app-header] a[href="/"]')
					.boundingBox();
				const edit = await page
					.getByRole("button", { name: "Back to edit", exact: true })
					.boundingBox();
				const worker = await identity.boundingBox();
				const account = await page
					.getByRole("button", { name: "Account menu", exact: true })
					.boundingBox();
				return (
					!!home &&
					!!edit &&
					!!worker &&
					!!account &&
					home.x + home.width <= edit.x &&
					worker.x + worker.width <= account.x
				);
			})
			.toBe(true);
		await test.info().attach("unassigned-worker-entry", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth))
			.toBeLessThanOrEqual(320);
	} finally {
		await page.setViewportSize(viewport);
	}
	await setup
		.getByRole("button", { name: "Test journeys", exact: true })
		.click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
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
	// Changing workers starts at entry, not inside a form their menu hides.
	await identity.click();
	await page.getByRole("menuitemradio", { name: /^Preview as me/ }).click();
	await expect(page).toHaveURL(`/build/${appId}`);
	await expect(main.getByLabel("Visit note")).toHaveCount(0);
	await expect(main.getByRole("button", { name: /^Visits\b/ })).toBeHidden();
	await identity.click();
	await page
		.getByRole("menuitemradio", {
			name: "Preview as Visit worker No place assigned",
			exact: true,
		})
		.click();
	await main.getByRole("button", { name: /^Visits\b/ }).click();
	await main.getByRole("button", { name: /^Record visit\b/ }).click();
	await expect(main.getByLabel("Visit note")).toHaveValue("");
	await identity.click();
	await page.getByRole("menuitemradio", { name: /^Preview as me/ }).click();
	await setup
		.getByRole("button", { name: "Identity setup", exact: true })
		.click();
	await expect(page).toHaveURL(`/build/${appId}/setup/users`);
	await expect(
		page.getByRole("region", { name: "Personas", exact: true }),
	).toContainText("Visit worker");
});

test("leaves Preview to add its first persona without claiming missing setup in a plain app", {
	tag: "@seed:organization",
}, async ({ scenario, page }) => {
	const { organizationAppId: appId } = seedFor(scenario, "organization");
	await page.goto(`/build/${appId}`);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(
		page.getByRole("region", { name: "Preview identity setup" }),
	).toHaveCount(0);
	await page.getByRole("button", { name: /Running as/ }).click();
	await page.getByRole("menuitem", { name: /^Add a persona/ }).click();
	await expect(page).toHaveURL(`/build/${appId}/setup/users`);
	await expect(
		page.getByRole("button", { name: "Preview", exact: true }),
	).toBeVisible();
	await expect(
		page
			.getByRole("region", { name: "Personas", exact: true })
			.getByRole("button", { name: "Add persona", exact: true }),
	).toBeEnabled();
});
