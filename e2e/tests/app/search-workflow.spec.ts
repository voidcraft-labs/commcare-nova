import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { SEARCH_STANDING_SEED } from "../../lib/searchStandingSeed";

/**
 * When this menu opens: the Search panel's three choices and the Forms read
 * the search switch, each offered by where the app runs. A choice a declared
 * platform can't run stays in the list, disabled with that platform's picker
 * line (`platformPickerLine`), and a choice that is offered writes the stored
 * workflow.
 */

/** `list-first`'s own picker line: Web Apps opens a searching menu on Search. */
const WEB_APPS_LIST_FIRST_LINE =
	"Not available in Web Apps. You can open this menu on Search first, which Android still opens on its case list, or change where this app runs in App settings.";
/** `forms-read-search` has no line of its own, so it reads the generic one. */
const ANDROID_PICKER_LINE =
	"Not available on Android. You can change where this app runs in App settings.";

/** Open the Search canvas and its panel's inspector, where the choice lives. */
async function openWorkflowSetting(page: Page, route: string) {
	await openBuilder(page, route);
	await expect(
		page.getByRole("heading", { name: "Search", level: 1 }),
	).toBeVisible({ timeout: 20_000 });
	await page.locator("[data-case-search-panel]").click();
	const setting = page.locator("[data-search-workflow-setting]");
	await expect(
		setting.getByRole("group", { name: "When this menu opens" }),
	).toBeVisible();
	const choice = (label: string) =>
		setting.getByRole("radio", { name: new RegExp(`^${label}`) });
	const choiceRow = (workflow: string) =>
		setting.locator(`[data-search-workflow-choice="${workflow}"]`);
	const formsReadSearch = page.locator("[data-forms-read-search]");
	return {
		setting,
		choice,
		choiceRow,
		formsReadSearch,
		formsReadSearchSwitch: formsReadSearch.getByRole("switch", {
			name: /^Forms read the search/,
		}),
	};
}

test("an app on both platforms offers Search first and Results first, and choosing Results first saves it", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "workspace");
	const { setting, choice, choiceRow, formsReadSearch, formsReadSearchSwitch } =
		await openWorkflowSetting(page, seed.caseWorkspace.routes.search);

	await expect(setting).toHaveAttribute(
		"data-search-workflow-setting",
		"searchFirst",
	);
	await expect(choice("Search first")).toBeChecked();
	await expect(choice("Search first")).toBeEnabled();
	await expect(choice("Results first")).toBeEnabled();
	// Web Apps is declared, so a searching menu can't open on its case list.
	await expect(choice("Case list first")).toBeDisabled();
	await expect(choiceRow("listFirst")).toContainText(WEB_APPS_LIST_FIRST_LINE);
	// Android is declared, so the forms can't read the search.
	await expect(formsReadSearchSwitch).toBeDisabled();
	await expect(formsReadSearchSwitch).not.toBeChecked();
	await expect(formsReadSearch).toContainText(ANDROID_PICKER_LINE);

	const saved = page.waitForResponse((response) => {
		const request = response.request();
		return (
			request.method() === "PUT" &&
			new URL(response.url()).pathname ===
				`/api/apps/${seed.caseWorkspace.appId}` &&
			(request.postData() ?? "").includes('"workflow":"skipToResults"')
		);
	});
	await choiceRow("skipToResults").click();
	expect((await saved).ok()).toBe(true);
	await expect(choice("Results first")).toBeChecked();
	await expect(setting).toHaveAttribute(
		"data-search-workflow-setting",
		"skipToResults",
	);
	await expect(page.locator("[data-search-workflow]")).toHaveAttribute(
		"data-search-workflow",
		"skipToResults",
	);
	// The switch stays under Results first, still withheld by Android.
	await expect(formsReadSearchSwitch).toBeDisabled();
	await expect(choice("Case list first")).toBeDisabled();
});

test("an app on Web Apps alone offers Forms read the search and withholds Case list first", {
	tag: "@seed:forms-read-search",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "forms-read-search");
	const { choice, choiceRow, formsReadSearch, formsReadSearchSwitch } =
		await openWorkflowSetting(page, seed.formsReadSearch.routes.searchConfig);

	await expect(choice("Search first")).toBeChecked();
	await expect(choice("Results first")).toBeEnabled();
	await expect(choice("Case list first")).toBeDisabled();
	await expect(choiceRow("listFirst")).toContainText(WEB_APPS_LIST_FIRST_LINE);
	await expect(formsReadSearch).toHaveAttribute(
		"data-forms-read-search",
		"true",
	);
	await expect(formsReadSearchSwitch).toBeChecked();
	// No platform the app runs on withholds it.
	await expect(formsReadSearch).not.toContainText(ANDROID_PICKER_LINE);
});

/**
 * A list that opens on Results first and whose forms read the search keeps
 * the search the worker ran when the browser's history returns to it. Web
 * Apps restores each step's query with the page's address
 * (`cloudcare/js/formplayer/utils/utils.js::CloudcareUrl.fromJson`) and
 * Formplayer answers the query prompts from it before it runs the query
 * again (`MenuSessionRunnerService.java::handleQueryScreen`), so the
 * worker sees their own search, never the menu's default search over every
 * case. Opening the other list in between makes Preview build the Patients
 * screen afresh, where taking the standing search back and launching the
 * default search are two effects of one mount
 * (`caseListPhase.ts::caseListLaunchesDefaultSearch`).
 */
test("a list that opens on Results keeps the worker's search when history returns to it", {
	tag: "@seed:search-standing",
}, async ({ scenario, page }) => {
	const { searchStanding } = seedFor(scenario, "search-standing");
	const { clinic, searching, browsing, searched, other, prompt } =
		SEARCH_STANDING_SEED;
	test.setTimeout(90_000);
	const main = page.locator("main");
	const trail = page.getByRole("navigation", { name: "Page navigation" });
	const searchScreen = main.getByRole("search", { name: "Search" });
	const rows = main
		.getByRole("list", { name: "Cases", exact: true })
		.getByRole("listitem");
	const menuItem = (name: string) =>
		main.getByRole("button", { name: new RegExp(`^${name}\\b`) });
	const expectRows = async (names: readonly string[]) => {
		await expect(rows).toHaveCount(names.length, { timeout: 20_000 });
		for (const name of names)
			await expect(rows.filter({ hasText: name })).toHaveCount(1);
	};

	await openBuilder(page, searchStanding.route);
	await page.getByRole("button", { name: "Preview", exact: true }).click();

	await test.step("Patients opens on its default search, which finds both patients", async () => {
		await menuItem(clinic.name).click();
		await menuItem(searching.name).click();
		await expectRows([searched.caseName, other.caseName]);
	});

	await test.step("the worker searches for one patient", async () => {
		await main.getByRole("button", { name: "Search again" }).click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
		await searchScreen
			.getByRole("textbox", { name: prompt.label })
			.fill(searched.answer);
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
		await expectRows([searched.caseName]);
	});

	await test.step("the worker opens the other list from the menu", async () => {
		await trail.getByRole("button", { name: clinic.name, exact: true }).click();
		await menuItem(browsing.name).click({ timeout: 20_000 });
		await expectRows([searched.caseName, other.caseName]);
	});

	await test.step("history returns to Patients, where the worker's search still stands", async () => {
		await page.goBack();
		await expect(menuItem(browsing.name)).toBeVisible({ timeout: 20_000 });
		await page.goBack();
		await expectRows([searched.caseName]);
		await expect(
			main.getByRole("button", { name: "Search again" }),
		).toBeVisible();
	});
});
