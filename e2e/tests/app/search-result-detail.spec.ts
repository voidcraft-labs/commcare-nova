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
