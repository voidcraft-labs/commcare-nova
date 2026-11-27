import type { Locator } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { SEARCH_RESULTS_SEED } from "../../lib/previewRuntimeSeeds";

/**
 * A form that reads what its module's search found opens with that search's
 * results, as a device's session holds them. A record link reloaded in the
 * browser keeps the record but no search, so the form has nothing to read;
 * it offers the way back to Search.
 *
 * The cap line (more matches than a search sends a device) is proven at the
 * read itself (`searchResultsSnapshot.postgres.test.ts`): seeding past the
 * cap costs more than a smoke should.
 */
test("a form reading search results opens after a search and asks for one after a reload", {
	tag: "@seed:search-results",
}, async ({ scenario, page }) => {
	const { searchResults } = seedFor(scenario, "search-results");
	const { match, missing, prompt, moduleName, formName, noteLabel } =
		SEARCH_RESULTS_SEED;
	test.setTimeout(90_000);
	const main = page.locator("main");
	const searchScreen = main.getByRole("search", { name: "Search" });
	const rows = main
		.getByRole("list", { name: "Cases", exact: true })
		.getByRole("listitem");
	const refusal = main.locator(
		'[data-search-results-refusal="no-completed-search"]',
	);
	const note = main.getByRole("textbox", {
		name: new RegExp(`${noteLabel}$`),
	});
	/** Continue from the record, then choose the form: CommCare lists the
	 *  menu's form once the record is chosen. */
	const continueToForm = async (opened: Locator) => {
		await main.getByRole("button", { name: "Continue", exact: true }).click();
		await main
			.getByRole("button", { name: new RegExp(`^${formName}\\b`) })
			.click({ timeout: 20_000 });
		await expect(opened).toBeVisible({ timeout: 20_000 });
	};

	await openBuilder(page, searchResults.route);
	await expect(
		page.getByRole("button", { name: "Preview", exact: true }),
	).toBeVisible({ timeout: 20_000 });
	await page.getByRole("button", { name: "Preview", exact: true }).click();

	let recordUrl = "";
	await test.step("the search finds the record, and the form opens with what it found", async () => {
		await main
			.getByRole("button", { name: new RegExp(`^${moduleName}\\b`) })
			.click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
		await expect(main.getByText(match.note, { exact: true })).toHaveCount(0);
		await searchScreen
			.getByRole("textbox", { name: prompt.label })
			.fill(match.caseName);
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
		await expect(rows).toHaveCount(1, { timeout: 20_000 });
		await expect(rows.getByText(match.note, { exact: true })).toBeVisible();
		await main
			.getByRole("button", {
				name: new RegExp(`^View details for ${match.caseName}`),
			})
			.click();
		await expect(page).toHaveURL(new RegExp(`/cases/${searchResults.caseId}`), {
			timeout: 20_000,
		});
		recordUrl = page.url();
		await continueToForm(note);
		await expect(refusal).toHaveCount(0);
		await expect(
			main.getByRole("button", { name: "Submit", exact: true }),
		).toBeEnabled();
	});

	await test.step("the reloaded record link keeps no search, so the form offers Search", async () => {
		await openBuilder(page, recordUrl);
		await expect(main.getByText(match.note, { exact: true })).toHaveCount(0);
		await continueToForm(refusal);
		await expect(refusal).toContainText("This form opens after a search");
		await expect(note).toHaveCount(0);
		await refusal
			.getByRole("button", { name: "Go to Search", exact: true })
			.click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
	});

	await test.step("an absent property stays empty and an unmatched search offers no case", async () => {
		const searchFor = async (name: string) => {
			await searchScreen
				.getByRole("textbox", { name: prompt.label })
				.fill(name);
			await searchScreen
				.getByRole("button", { name: "Search All Cases", exact: true })
				.click();
		};
		await searchFor(missing.caseName);
		await expect(
			rows.getByText(missing.caseName, { exact: true }),
		).toBeVisible();
		await expect(rows).toHaveCount(1);
		await expect(rows.getByText(match.note, { exact: true })).toHaveCount(0);
		await main
			.getByRole("button", { name: "Search again", exact: true })
			.click();
		await searchFor("no-matching-worker-record");
		await expect(
			main.getByRole("button", { name: "Search again", exact: true }),
		).toBeVisible();
		await expect(rows).toHaveCount(0);
	});
});
