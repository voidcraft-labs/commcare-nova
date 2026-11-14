import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";
import { SEARCH_VALUE_LIST_SEED } from "../../lib/previewRuntimeSeeds";

/**
 * A search field's rule compares a case value with a list of values, edited
 * row by row in the builder, kept across a reload, and searched by Preview
 * over real case rows.
 *
 * The Region field starts as "once answered, region is north". The journey
 * turns "north" into a list, adds "south", adds the Region answer itself,
 * moves the answer up from its handle, and removes "north", so the saved rule
 * is "region is any of the Region answer or south". The four clients live in
 * four regions, so each answer separates them: a value the card dropped,
 * kept, or put in the wrong place shows as the wrong rows.
 */
test("a list of values in a search field's rule is edited, kept and searched", {
	tag: "@seed:search-value-list",
}, async ({ scenario, page }) => {
	const { searchValueList } = seedFor(scenario, "search-value-list");
	const { region, age, moduleName } = SEARCH_VALUE_LIST_SEED;
	test.setTimeout(120_000);
	const main = page.locator("main");
	const items = page.locator("[data-value-list-item]");
	const listChoice = page.getByRole("menuitem", { name: /^A list of values/ });

	/** Open a search field's rule in the full-width condition editor. */
	const openRule = async (field: { uuid: string; label: string }) => {
		await expect(
			page.getByRole("heading", { name: "Search", level: 1 }),
		).toBeVisible({ timeout: 20_000 });
		await page.locator(`[data-case-search-field="${field.uuid}"]`).click();
		await page
			.getByRole("button", { name: "Edit condition", exact: true })
			.click();
		await expect(
			page.getByRole("heading", {
				name: `Match cases for ${field.label}`,
				level: 1,
			}),
		).toBeVisible();
	};
	/** Wait for the builder to save the edit just made. */
	const saved = () =>
		page.waitForResponse(
			(response) =>
				response.request().method() === "PUT" &&
				new URL(response.url()).pathname ===
					`/api/apps/${searchValueList.appId}`,
		);

	await test.step("beside an ordering the list is offered disabled, with the gate's reason", async () => {
		await openBuilder(page, searchValueList.route);
		await openRule(age);
		await page
			.getByRole("button", { name: /^Value source: / })
			.first()
			.click();
		await expect(listChoice).toBeVisible();
		await expect(listChoice).toBeDisabled();
		await expect(listChoice).toContainText(
			"can be compared only as equal or not equal",
		);
		await page.keyboard.press("Escape");
		await expect(listChoice).toHaveCount(0);
	});

	await test.step("beside is, the value becomes a list that keeps it", async () => {
		await openBuilder(page, searchValueList.route);
		await openRule(region);
		await page
			.getByRole("button", { name: /^Value source: / })
			.first()
			.click();
		await expect(listChoice).toBeEnabled();
		const done = saved();
		await listChoice.click();
		expect((await done).ok()).toBe(true);
		await page
			.getByRole("button", { name: "Edit a list of values", exact: true })
			.click();
		await expect(
			page.getByText("Any of these values", { exact: true }),
		).toBeVisible();
		await expect(items).toHaveCount(1);
		await expect(
			items.nth(0).getByRole("textbox", { name: "Text value" }),
		).toHaveValue(SEARCH_VALUE_LIST_SEED.startRegion);
		// One value is the least a list holds, so its row has no remove action.
		await expect(
			page.getByRole("button", { name: "Remove value 1", exact: true }),
		).toHaveCount(0);
	});

	await test.step("add a value, add the search answer, move it up, remove the first", async () => {
		const addValue = page.getByRole("button", {
			name: "Add a value",
			exact: true,
		});
		await addValue.click();
		await expect(items).toHaveCount(2);
		const second = items.nth(1).getByRole("textbox", { name: "Text value" });
		await second.fill("south");
		await second.press("Tab");

		await addValue.click();
		await expect(items).toHaveCount(3);
		await items
			.nth(2)
			.getByRole("button", { name: /^Value source: / })
			.click();
		await page.getByRole("menuitemradio", { name: /^A search answer/ }).click();
		// The rule reads its own field's answer, which "once answered" guards.
		const answer = items
			.nth(2)
			.getByRole("button", { name: /^Search answer: / });
		await answer.click();
		await page
			.getByRole("menuitem", { name: new RegExp(`^${region.label}\\b`) })
			.click();
		await expect(answer).toContainText(region.label);

		// The handle moves its row from the keyboard and says where it went.
		const handle = page.getByRole("button", {
			name: "Move value 3 of 3",
			exact: true,
		});
		await handle.focus();
		await handle.press("ArrowUp");
		await expect(page.getByText("Value 3 moved earlier")).toBeAttached();
		await expect(
			items.nth(1).getByRole("button", { name: /^Search answer: / }),
		).toContainText(region.label);
		await expect(
			items.nth(2).getByRole("textbox", { name: "Text value" }),
		).toHaveValue("south");

		const done = saved();
		await page
			.getByRole("button", { name: "Remove value 1", exact: true })
			.click();
		expect((await done).ok()).toBe(true);
		await expect(items).toHaveCount(2);
		await expect(
			items.nth(0).getByRole("button", { name: /^Search answer: / }),
		).toContainText(region.label);
		await expect(
			items.nth(1).getByRole("textbox", { name: "Text value" }),
		).toHaveValue("south");
		await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 20_000 });
	});

	await test.step("after a reload the card shows the values that were saved", async () => {
		await reloadBuilder(page);
		await openRule(region);
		await page
			.getByRole("button", { name: "Edit a list of values", exact: true })
			.click();
		await expect(items).toHaveCount(2);
		await expect(
			items.nth(0).getByRole("button", { name: /^Search answer: / }),
		).toContainText(region.label);
		await expect(
			items.nth(1).getByRole("textbox", { name: "Text value" }),
		).toHaveValue("south");
	});

	const searchScreen = main.getByRole("search", { name: "Search" });
	const rows = main.getByRole("list", { name: "Cases" }).getByRole("listitem");
	const search = async (answer: string) => {
		if (!(await searchScreen.isVisible()))
			await main.getByRole("button", { name: "Search again" }).click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
		await searchScreen
			.getByRole("textbox", { name: region.label })
			.fill(answer);
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
	};
	const expectClients = async (names: readonly string[]) => {
		await expect(rows).toHaveCount(names.length, { timeout: 20_000 });
		for (const name of names)
			await expect(rows.filter({ hasText: name })).toHaveCount(1);
	};

	await test.step("open Search in Preview", async () => {
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const menu = main.getByRole("button", {
			name: new RegExp(`^${moduleName}\\b`),
		});
		await expect(searchScreen.or(menu)).toBeVisible({ timeout: 20_000 });
		if (await menu.isVisible()) await menu.click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
	});

	await test.step("the search finds a case whose region is any listed value", async () => {
		await search("east");
		await expectClients(["Bo", "Cy"]);
	});

	await test.step("a different answer changes the list, and north is no longer in it", async () => {
		await search("west");
		await expectClients(["Bo", "Di"]);
	});
});
