import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { SEARCH_CLAIM_SEED } from "../../lib/previewRuntimeSeeds";

/**
 * A search reads past the worker's device, so it can find a record another
 * worker owns. Choosing it claims it, as CommCare does, and the form then
 * opens with that record's saved values. Results read the search's own
 * population, so they carry no note about records left off the device.
 */
test("a searched record another persona owns opens its form with its case data", {
	tag: "@seed:search-claim",
}, async ({ scenario, page }) => {
	const { searchClaim } = seedFor(scenario, "search-claim");
	const { searcher, match, prompt, moduleName, noteLabel } = SEARCH_CLAIM_SEED;
	test.setTimeout(90_000);
	const main = page.locator("main");
	const identity = page
		.locator("[data-app-header]")
		.getByRole("button", { name: /Running as/ });
	const searchScreen = main.getByRole("search", { name: "Search" });
	const rows = main
		.getByRole("list", { name: "Cases", exact: true })
		.getByRole("listitem");

	await openBuilder(page, searchClaim.route);
	await expect(
		page.getByRole("button", { name: "Preview", exact: true }),
	).toBeVisible({ timeout: 20_000 });
	await page.getByRole("button", { name: "Preview", exact: true }).click();

	await test.step(`Preview runs as ${searcher.name}, who owns no records`, async () => {
		await identity.click();
		await page
			.getByRole("menuitemradio", {
				name: new RegExp(`^Preview as ${searcher.name}\\b`),
			})
			.click();
		await expect(identity).toHaveAccessibleName(
			new RegExp(`Running as ${searcher.name}\\b`),
		);
	});

	await test.step("the search finds the record another persona owns, with no restore note", async () => {
		await main
			.getByRole("button", { name: new RegExp(`^${moduleName}\\b`) })
			.click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
		await searchScreen
			.getByRole("textbox", { name: prompt.label })
			.fill(match.caseName);
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
		await expect(rows).toHaveCount(1, { timeout: 20_000 });
		await expect(rows.first()).toContainText(match.caseName);
		await expect(main.getByText(/would not be on .* device/)).toHaveCount(0);
	});

	await test.step("choosing it opens the form with its saved values", async () => {
		await main
			.getByRole("button", {
				name: new RegExp(`^View details for ${match.caseName}`),
			})
			.click();
		await main.getByRole("button", { name: "Continue", exact: true }).click();
		const note = main.getByRole("textbox", {
			name: new RegExp(`${noteLabel}$`),
		});
		await expect(note).toHaveValue(match.lastNote, { timeout: 20_000 });
		await expect(
			main.getByRole("button", { name: "Submit", exact: true }),
		).toBeEnabled();
	});
});
