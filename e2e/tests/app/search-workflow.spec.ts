import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

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
