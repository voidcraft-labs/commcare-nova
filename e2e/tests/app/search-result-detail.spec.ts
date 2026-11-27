import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { SEARCH_STANDING_SEED } from "../../lib/searchStandingSeed";

test("Search result Details keep the answer from the Results page that opened them", {
	tag: "@seed:search-standing",
}, async ({ scenario, page }) => {
	const { searchStanding } = seedFor(scenario, "search-standing");
	const { clinic, resultDetail, searched, prompt } = SEARCH_STANDING_SEED;
	const main = page.locator("main");
	const search = main.getByRole("search", { name: "Search" });
	const openResult = () =>
		main
			.getByRole("button", {
				name: new RegExp(`^View details for ${searched.caseName}`),
			})
			.click();
	const submit = () =>
		search
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
	const entered = (answer: string) =>
		main.getByText(`Entered [${answer}]`, { exact: true });

	await openBuilder(page, searchStanding.route);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await main
		.getByRole("button", { name: new RegExp(`^${clinic.name}\\b`) })
		.click();
	await main
		.getByRole("button", { name: new RegExp(`^${resultDetail.name}\\b`) })
		.click();
	await expect(search).toBeVisible();

	await search
		.getByRole("textbox", { name: prompt.label })
		.fill(searched.answer);
	await submit();
	await openResult();
	await expect(entered(searched.answer)).toBeVisible();
	await page.getByRole("button", { name: /^Worker language:/ }).click();
	await page
		.getByRole("menuitemradio", { name: "Español", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Worker language: Spanish" }),
	).toBeVisible();
	await expect(entered(searched.answer)).toBeVisible();
	await page.goBack();
	await expect(
		page.getByRole("button", { name: "Worker language: English" }),
	).toBeVisible();
	await expect(entered(searched.answer)).toBeVisible();

	await page.goBack();
	await expect(
		main.getByRole("button", { name: "Search again" }),
	).toBeVisible();
	await page.goForward();
	await expect(entered(searched.answer)).toBeVisible();
	await page.goBack();
	await main.getByRole("button", { name: "Search again" }).click();
	await expect(search).toBeVisible();
	await search.getByRole("textbox", { name: prompt.label }).fill("");
	await submit();
	await openResult();
	await expect(entered("")).toBeVisible();
	await expect(entered(searched.answer)).toHaveCount(0);
});

test("a new Details calculation can use a menu's Search text prompt", {
	tag: "@seed:search-standing",
}, async ({ scenario, page }) => {
	const { searchStanding } = seedFor(scenario, "search-standing");
	const { resultDetail, prompt } = SEARCH_STANDING_SEED;
	await openBuilder(
		page,
		`${searchStanding.route}/${resultDetail.moduleUuid}/details`,
	);
	await page.getByRole("combobox", { name: "Add information" }).click();
	await page.getByRole("option", { name: /^Calculated value/ }).click();
	const answer = page.getByRole("combobox", {
		name: "Submitted Search answer",
	});
	await expect(answer).toContainText("None");
	await answer.click();
	const saved = page.waitForResponse(
		(response) =>
			response.ok() &&
			(response.request().postData()?.includes('"searchResultDetail"') ??
				false),
	);
	await page.getByRole("option", { name: prompt.label, exact: true }).click();
	await expect(answer).toContainText(prompt.label);
	await expect(
		page.getByRole("textbox", { name: "Text outside Search results" }),
	).toHaveValue("");
	await saved;
});
