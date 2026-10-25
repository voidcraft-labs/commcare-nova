import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { SEARCH_CHOICE_SEED } from "../../lib/previewRuntimeSeeds";

/**
 * A search field's condition that depends on another answer, with its
 * distance read from an answer, finds what Preview's search finds over real
 * case rows.
 *
 * The Radius field starts as "once answered, a site's home is within 2 km of
 * 0 0". The journey makes that condition depend on a condition: while Area is
 * blank it keeps 2 km; otherwise the distance is the Radius answer. The
 * sites sit about 1.1, 5.6 and 55.6 km from the point, so each answer
 * separates them: a branch the card committed wrongly, or a distance the
 * search did not work out from the answer, shows as the wrong row count.
 */
test("a search condition that depends on an answer and reads its distance from one changes Preview's results", {
	tag: "@seed:search-choice",
}, async ({ scenario, page }) => {
	const { searchChoice } = seedFor(scenario, "search-choice");
	const { radius, area, sites, moduleName } = SEARCH_CHOICE_SEED;
	test.setTimeout(120_000);
	const main = page.locator("main");

	await test.step("author the choice and the distance in the Radius condition", async () => {
		await openBuilder(page, searchChoice.route);
		await expect(
			page.getByRole("heading", { name: "Search", level: 1 }),
		).toBeVisible({ timeout: 20_000 });
		await page.locator(`[data-case-search-field="${radius.uuid}"]`).click();
		await page
			.getByRole("button", { name: "Edit condition", exact: true })
			.click();
		await expect(
			page.getByRole("heading", {
				name: `Match cases for ${radius.label}`,
				level: 1,
			}),
		).toBeVisible();

		// The near condition sits inside "after a search answer" and edits in
		// place there; its verb menu offers the choice under Special conditions.
		await page
			.getByRole("button", { name: "Condition is near", exact: true })
			.click();
		await page
			.getByRole("menuitem", { name: /^Depends on a condition/ })
			.click();
		// The new choice decides by whether Area is blank, and both branches
		// start as the near condition, so nothing the search finds changes yet.
		await expect(
			page.getByText("Otherwise use", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Edit is blank", exact: true }),
		).toBeVisible();
		const branches = page.getByRole("button", {
			name: "Edit is near",
			exact: true,
		});
		await expect(branches).toHaveCount(2);

		// Open "Otherwise use" and read its distance from the Radius answer.
		const saved = page.waitForResponse(
			(response) =>
				response.request().method() === "PUT" &&
				new URL(response.url()).pathname === `/api/apps/${searchChoice.appId}`,
		);
		await branches.nth(1).click();
		await page
			.getByRole("button", { name: "Use a value", exact: true })
			.first()
			.click();
		await expect(
			page.getByRole("button", { name: "Use a fixed distance", exact: true }),
		).toBeVisible();
		expect((await saved).ok()).toBe(true);
		await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 20_000 });
	});

	const searchScreen = main.getByRole("search", { name: "Search" });
	const radiusAnswer = searchScreen.getByRole("textbox", {
		name: radius.label,
	});
	const areaAnswer = searchScreen.getByRole("textbox", { name: area.label });
	const rows = main.getByRole("list", { name: "Cases" }).getByRole("listitem");
	const search = async (answers: { radius: string; area: string }) => {
		if (!(await searchScreen.isVisible()))
			await main.getByRole("button", { name: "Search again" }).click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
		await radiusAnswer.fill(answers.radius);
		await areaAnswer.fill(answers.area);
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
	};
	const expectSites = async (names: readonly string[]) => {
		await expect(rows).toHaveCount(names.length, { timeout: 20_000 });
		for (const name of names)
			await expect(rows.filter({ hasText: name })).toHaveCount(1);
	};
	const [yard, market, farm] = sites.map((site) => site.caseName);

	await test.step("open Search in Preview", async () => {
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const menu = main.getByRole("button", {
			name: new RegExp(`^${moduleName}\\b`),
		});
		await expect(searchScreen.or(menu)).toBeVisible({ timeout: 20_000 });
		if (await menu.isVisible()) await menu.click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
	});

	await test.step("with Area blank the choice keeps 2 km", async () => {
		await search({ radius: "10", area: "" });
		await expectSites([yard]);
	});

	await test.step("answering Area switches to the Radius answer's distance", async () => {
		await search({ radius: "10", area: "east" });
		await expectSites([yard, market]);
	});

	await test.step("a wider Radius answer widens the search", async () => {
		await search({ radius: "100", area: "east" });
		await expectSites([yard, market, farm]);
	});

	await test.step("clearing Area returns to 2 km, whatever Radius says", async () => {
		await search({ radius: "100", area: "" });
		await expectSites([yard]);
	});
});
