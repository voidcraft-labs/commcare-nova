import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { SEARCH_START_REFUSED_SEED } from "../../lib/previewRuntimeSeeds";

/**
 * A form of a menu whose forms read the search, opened with no search behind
 * it, reads each Search field's starting value as a phone builds the search
 * the form reads (Core's `RemoteQuerySessionManager`). Here the one field
 * starts on the worker's primary place, and the member previewing is a
 * worker assigned nowhere, whose session holds no such key, so a phone stops
 * there and never opens the form. Preview shows the Search screen's refusal
 * in the form's place, with Back to the menu.
 *
 * A URL cannot reach that form with no search behind it (Preview routes it
 * back to the menu's Search), so the journey opens it the way a worker does:
 * through its deep link.
 */
test("a deep-linked form whose search starts on a place the worker lacks stops as a phone does", {
	tag: "@seed:search-start-refused",
}, async ({ scenario, page }) => {
	const { searchStartRefused } = seedFor(scenario, "search-start-refused");
	const seed = SEARCH_START_REFUSED_SEED;
	test.setTimeout(90_000);
	const main = page.locator("main");

	await openBuilder(
		page,
		`${searchStartRefused.route}/${seed.entryPoint.uuid}`,
	);
	await expect(page.getByLabel("Link ID", { exact: true })).toHaveValue(
		seed.entryPoint.id,
		{ timeout: 20_000 },
	);

	await test.step("the deep link opens the form for the member, who is assigned nowhere", async () => {
		await page
			.getByRole("combobox", {
				name: `${seed.moduleName} cases`,
				exact: true,
			})
			.click();
		await page
			.getByRole("option", { name: seed.patient.caseName, exact: true })
			.click();
		const launch = page.getByRole("button", {
			name: "Test in Preview",
			exact: true,
		});
		await expect(launch).toBeEnabled();
		await launch.click();
		await expect(page).toHaveURL(
			new RegExp(`/build/${searchStartRefused.appId}/${seed.formUuid}`),
			{ timeout: 20_000 },
		);
	});

	await test.step("the form shows the search's refusal in its place, naming what to change", async () => {
		const refusal = main.locator(
			'[data-preview-data-refusal="worker-information"]',
		);
		await expect(refusal).toBeVisible({ timeout: 20_000 });
		await expect(refusal).toHaveAttribute("role", "alert");
		await expect(refusal).toHaveAttribute(
			"data-preview-data-refusal-surface",
			"search",
		);
		await expect(
			refusal.getByRole("heading", {
				name: "This search doesn't open on a phone",
				exact: true,
			}),
		).toBeVisible();
		await expect(refusal).toContainText(
			"This search reads worker information you don't have",
		);
		await expect(
			main.getByRole("textbox", { name: seed.noteLabel }),
		).toHaveCount(0);
		await expect(
			main.getByRole("button", { name: "Submit", exact: true }),
		).toHaveCount(0);

		await refusal.getByRole("button", { name: "Back", exact: true }).click();
		await expect(page).toHaveURL(
			new RegExp(`/build/${searchStartRefused.appId}/${seed.moduleUuid}`),
			{ timeout: 20_000 },
		);
		await expect(page).not.toHaveURL(new RegExp(seed.formUuid));
		await expect(
			main.getByRole("textbox", { name: seed.noteLabel }),
		).toHaveCount(0);
	});
});
