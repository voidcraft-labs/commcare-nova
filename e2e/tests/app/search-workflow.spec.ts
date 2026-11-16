import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { pressTrailCrumb } from "../../lib/breadcrumbTrail";
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
 * case. The address keeps only that the query ran: its answers are the ones
 * the worker last gave the query (`Utils.getCurrentQueryInputs`), so after a
 * second search the first one's entry shows the second's answers. Opening
 * the other list in between makes Preview build the Patients
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
		await pressTrailCrumb(page, clinic.name);
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

	await test.step("after a second search, history runs the earlier search with the answers the worker last gave", async () => {
		// Web Apps keeps the answers the worker last gave each query in the
		// page (`utils.js::Utils.setCurrentQueryInputs`), and an address
		// records only that its query ran: Back answers it with those
		// (`CloudcareUrl.fromJson` over `Utils.getCurrentQueryInputs`).
		await pressTrailCrumb(page, clinic.name);
		await menuItem(searching.name).click({ timeout: 20_000 });
		await expectRows([searched.caseName, other.caseName]);
		await main.getByRole("button", { name: "Search again" }).click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
		await searchScreen
			.getByRole("textbox", { name: prompt.label })
			.fill(other.answer);
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
		await expectRows([other.caseName]);
		await page.goBack();
		await expect(menuItem(searching.name)).toBeVisible({ timeout: 20_000 });
		// The entry of the first search: its query runs again, with the
		// second search's answers.
		await page.goBack();
		await expectRows([other.caseName]);
		await expect(
			main.getByRole("button", { name: "Search again" }),
		).toBeVisible();
	});
});

/**
 * A list that opens on Results lets the worker's search go once the worker
 * leaves it, as Web Apps does. A crumb keeps only the queries recorded
 * before the screen it names (`utils.js::CloudcareUrl.spliceSelections`), so
 * the clinic's crumb leaves Patients' query behind, and opening Patients
 * again from the clinic carries no query: Formplayer runs the menu's default
 * search (`MenuSessionRunnerService.java::handleQueryScreen`). A submission
 * clears every query (`CloudcareUrl.onSubmit`), so the list a form returns
 * to runs its default search too (`lib/preview/searchStanding.ts`). A new
 * Preview run is a new session, so the list runs it again then as well.
 */
test("a list that opens on Results runs its default search again once the worker leaves it", {
	tag: "@seed:search-standing",
}, async ({ scenario, page }) => {
	const { searchStanding } = seedFor(scenario, "search-standing");
	const { clinic, searching, browsing, searched, other, prompt } =
		SEARCH_STANDING_SEED;
	test.setTimeout(120_000);
	const main = page.locator("main");
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
	const searchFor = async (answer: string) => {
		await main.getByRole("button", { name: "Search again" }).click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
		await searchScreen
			.getByRole("textbox", { name: prompt.label })
			.fill(answer);
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
	};

	await openBuilder(page, searchStanding.route);
	await page.getByRole("button", { name: "Preview", exact: true }).click();

	await test.step("the worker searches Patients for one patient", async () => {
		await menuItem(clinic.name).click();
		await menuItem(searching.name).click();
		await expectRows([searched.caseName, other.caseName]);
		await searchFor(searched.answer);
		await expectRows([searched.caseName]);
	});

	await test.step("after the clinic's crumb, another list and a step back, Patients runs its default search", async () => {
		await pressTrailCrumb(page, clinic.name);
		await menuItem(browsing.name).click({ timeout: 20_000 });
		await expectRows([searched.caseName, other.caseName]);
		await page.goBack();
		await expect(menuItem(browsing.name)).toBeVisible({ timeout: 20_000 });
		await menuItem(searching.name).click();
		await expectRows([searched.caseName, other.caseName]);
	});

	await test.step("a form submitted from a search returns to Patients, which runs its default search", async () => {
		await searchFor(searched.answer);
		await expectRows([searched.caseName]);
		await main
			.getByRole("button", {
				name: new RegExp(`^View details for ${searched.caseName}`),
			})
			.click();
		await main
			.getByRole("button", { name: "Continue", exact: true })
			.click({ timeout: 20_000 });
		await menuItem(searching.formName).click({ timeout: 20_000 });
		await main
			.getByRole("button", { name: "Submit", exact: true })
			.click({ timeout: 20_000 });
		await expectRows([searched.caseName, other.caseName]);
	});

	await test.step("history back past the submission returns to the Results the worker searched", async () => {
		// The submission dropped the query from the address it pushed alone
		// (`app.js`'s submit handler, `CloudcareUrl.onSubmit`): the earlier
		// addresses keep theirs, and Web Apps answers the query from the
		// inputs it keeps for it (`Utils.getCurrentQueryInputs`).
		await page.goBack();
		await expect(
			main.getByRole("button", { name: "Submit", exact: true }),
		).toBeVisible({ timeout: 20_000 });
		await page.goBack();
		await expect(menuItem(searching.formName)).toBeVisible({
			timeout: 20_000,
		});
		await page.goBack();
		await expectRows([searched.caseName]);
	});

	await test.step("the crumb of a menu whose forms read the search lets its search go", async () => {
		// The crumb cuts the selections back to Patients, and Web Apps keeps
		// only the queries recorded strictly before it
		// (`CloudcareUrl.spliceSelections`), so Patients' own query goes and
		// Formplayer runs its default search again.
		await main
			.getByRole("button", {
				name: new RegExp(`^View details for ${searched.caseName}`),
			})
			.click();
		await main
			.getByRole("button", { name: "Continue", exact: true })
			.click({ timeout: 20_000 });
		await menuItem(searching.formName).click({ timeout: 20_000 });
		await expect(
			main.getByRole("button", { name: "Submit", exact: true }),
		).toBeVisible({ timeout: 20_000 });
		await pressTrailCrumb(page, searching.name);
		await expectRows([searched.caseName, other.caseName]);
	});

	await test.step("leaving Preview and entering it again, Patients runs its default search for the new session", async () => {
		// A new Preview run is a new session, whose query screen Formplayer
		// builds afresh and runs the default search on (`handleQueryScreen`),
		// though the list's settings are unchanged and Preview kept the
		// screen (`caseListPhase.ts::caseListDefaultSearchOpening`).
		await searchFor(searched.answer);
		await expectRows([searched.caseName]);
		await page
			.getByRole("button", { name: "Back to edit", exact: true })
			.click();
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await expectRows([searched.caseName, other.caseName]);
		await expect(
			main.getByRole("button", { name: "Search again" }),
		).toBeVisible();
	});
});

/**
 * Every list's search lets go by the one rule, and so does a Search screen
 * the worker asked for again. Web Apps keeps each on the page's address as
 * query data (`utils.js::CloudcareUrl.setQueryData`): a Search action's
 * query as much as a query the menu's forms read, and Search again's
 * `force_manual_search`. Home (`clearExceptApp`), a submission
 * (`CloudcareUrl.onSubmit`) and a new session hold none of it, so
 * Formplayer runs the menu's default search again
 * (`MenuSessionRunnerService.java::handleQueryScreen`: `autoSearch` is
 * `doDefaultSearch() && !forceManualSearch`). Preview keeps each list's
 * screen when the worker leaves it, so each step returns to the very
 * screen that held the search or the Search screen
 * (`lib/preview/searchStanding.ts::previewSearchRunFollows`,
 * `previewSearchReopened`).
 */
test("a list lets its Search action's search, and a Search screen asked for again, go as Web Apps does", {
	tag: "@seed:search-standing",
}, async ({ scenario, page }) => {
	const { searchStanding } = seedFor(scenario, "search-standing");
	const { clinic, searching, finding, searched, other, prompt } =
		SEARCH_STANDING_SEED;
	test.setTimeout(150_000);
	const main = page.locator("main");
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
	const expectDefaultSearch = async () => {
		await expectRows([searched.caseName, other.caseName]);
		await expect(searchScreen).toBeHidden();
		await expect(
			main.getByRole("button", { name: "Search again" }),
		).toBeVisible();
	};
	const searchAgain = async () => {
		await main.getByRole("button", { name: "Search again" }).click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
	};
	const searchFor = async (answer: string) => {
		await searchAgain();
		await searchScreen
			.getByRole("textbox", { name: prompt.label })
			.fill(answer);
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
	};
	const openFrom = async (list: string) => {
		await pressTrailCrumb(page, "Home");
		await menuItem(clinic.name).click({ timeout: 20_000 });
		await menuItem(list).click({ timeout: 20_000 });
	};

	await openBuilder(page, searchStanding.route);
	await page.getByRole("button", { name: "Preview", exact: true }).click();

	await test.step("a Search action's search goes at Home, and its list runs its default search again", async () => {
		await menuItem(clinic.name).click();
		await menuItem(finding.name).click();
		await expectDefaultSearch();
		await searchFor(searched.answer);
		await expectRows([searched.caseName]);
		await openFrom(finding.name);
		await expectDefaultSearch();
	});

	await test.step("a Search action's search goes on the crumb of the menu above its list", async () => {
		// The crumb cuts the selections back to Clinic, and Web Apps keeps only
		// the queries recorded strictly before the cut
		// (`CloudcareUrl.spliceSelections`), so the list's query goes with it.
		await searchFor(searched.answer);
		await expectRows([searched.caseName]);
		await pressTrailCrumb(page, clinic.name);
		await menuItem(finding.name).click({ timeout: 20_000 });
		await expectDefaultSearch();
	});

	await test.step("a form submitted from a Search action's search returns to its list, which runs its default search", async () => {
		await searchFor(searched.answer);
		await expectRows([searched.caseName]);
		await main
			.getByRole("button", {
				name: new RegExp(`^View details for ${searched.caseName}`),
			})
			.click();
		await main
			.getByRole("button", { name: "Continue", exact: true })
			.click({ timeout: 20_000 });
		await menuItem(finding.formName).click({ timeout: 20_000 });
		await main
			.getByRole("button", { name: "Submit", exact: true })
			.click({ timeout: 20_000 });
		await expectDefaultSearch();
	});

	await test.step("Search again's Search screen goes at Home, and the list runs its default search", async () => {
		await openFrom(searching.name);
		await expectDefaultSearch();
		await searchAgain();
		await openFrom(searching.name);
		await expectDefaultSearch();
	});

	await test.step("Search again's Search screen goes with the Preview session, and the next one runs the default search", async () => {
		await searchAgain();
		await page
			.getByRole("button", { name: "Back to edit", exact: true })
			.click();
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await expectDefaultSearch();
	});
});
