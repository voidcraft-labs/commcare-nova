import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

/** Android's picker line (`platformPickerLine`): what withholds the choice,
 *  then the way forward. */
const ANDROID_PICKER_LINE =
	"Not available on Android. You can change where this app runs in App settings.";

test("a choice Android can't run is offered disabled, with its line", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "workspace");
	const routes = seed.caseWorkspace.routes;

	// Search settings: Forms read the search.
	await openBuilder(page, routes.search);
	await expect(
		page.getByRole("heading", { name: "Search", level: 1 }),
	).toBeVisible({ timeout: 20_000 });
	await page.locator("[data-case-search-panel]").click();
	const formsReadSearch = page.locator("[data-forms-read-search]");
	await expect(
		formsReadSearch.getByRole("switch", { name: /^Forms read the search/ }),
	).toBeDisabled();
	await expect(formsReadSearch).toContainText(ANDROID_PICKER_LINE);

	// The Last visit Search field's Date picker type.
	await page
		.locator("[data-case-search-field]")
		.filter({ hasText: "Last visit" })
		.click();
	await page.getByRole("button", { name: /^Search field \d+ type:/ }).click();
	const datePicker = page.getByRole("menuitemradio", { name: /^Date picker/ });
	await expect(datePicker).toBeDisabled();
	await expect(datePicker).toContainText(ANDROID_PICKER_LINE);
	await page.keyboard.press("Escape");

	// Results: Several cases.
	await openBuilder(page, routes.results);
	await expect(
		page.getByRole("heading", { name: "Results", level: 1 }),
	).toBeVisible({ timeout: 20_000 });
	const several = page.getByRole("radio", { name: /^Several cases/ });
	await expect(several).toBeDisabled();
	await expect(page.locator("label").filter({ has: several })).toContainText(
		ANDROID_PICKER_LINE,
	);
});

test("a change that strands forms that read the search lists it", {
	tag: "@seed:forms-read-search",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "forms-read-search");
	const fixture = seed.formsReadSearch;
	await openBuilder(page, fixture.routes.results);
	await page.getByRole("button", { name: "App settings", exact: true }).click();
	await page.locator('[data-platform-choice="both"]').click();
	const block = page.locator("[data-platform-refusal]");
	await expect(block).toContainText(/Android can't run/);
	const row = block
		.locator("li")
		.filter({ hasText: "has its forms read the search" });
	await row.getByRole("button", { name: /^Open / }).click();
	await expect(page).toHaveURL(
		new URL(fixture.routes.searchConfig, page.url()).toString(),
	);
	await expect(block).toBeVisible();
});
