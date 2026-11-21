import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { SEARCH_STANDING_SEED } from "../../lib/searchStandingSeed";

/**
 * A browser history entry outlives the page that wrote it, the signed-in
 * member and their Project membership, so Preview keeps there identifiers
 * and the topology of its steps alone: what an entry was shown with (the
 * case chosen, the list's form menu holding it, the search the worker typed)
 * is held in memory with the Preview session that showed it
 * (`lib/routing/builderHistoryState.ts`, `lib/routing/previewEntryRecords.ts`).
 *
 * The worker searches Patients for one patient, chooses her, which holds the
 * list's form menu on an entry of its own, opens the form and types a note.
 * Back then walks every entry the walk wrote: each screen comes back as it
 * was shown, and no entry's state holds a case's name, a search answer or
 * anything the worker typed.
 */

/** The builder's keys a history entry may hold. */
const BUILDER_KEYS = new Set([
	"__novaProjectScope",
	"__novaEntry",
	"__novaPreviousEntry",
	"__novaPreviousGap",
	"__novaPreviewSearches",
	"__novaPreviewSearchesEnd",
]);

const NOTE = "Asked about her second visit";

async function entryState(page: Page): Promise<string> {
	return page.evaluate(() => JSON.stringify(window.history.state ?? null));
}

async function builderKeys(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		Object.keys(
			(window.history.state as Record<string, unknown> | null) ?? {},
		).filter((key) => key.startsWith("__nova")),
	);
}

test("Preview's history holds no case, search answer or typed value, and Back still shows each screen as it was", {
	tag: "@seed:search-standing",
}, async ({ scenario, page }) => {
	const { searchStanding } = seedFor(scenario, "search-standing");
	const { clinic, searching, searched, other, prompt } = SEARCH_STANDING_SEED;
	test.setTimeout(120_000);
	const main = page.locator("main");
	const searchScreen = main.getByRole("search", { name: "Search" });
	const rows = main
		.getByRole("list", { name: "Cases", exact: true })
		.getByRole("listitem");
	const menuItem = (name: string) =>
		main.getByRole("button", { name: new RegExp(`^${name}\\b`) });
	const menuTitle = main.locator("[data-form-menu-case-title]");
	const submit = main.getByRole("button", { name: "Submit", exact: true });
	const expectRows = async (names: readonly string[]) => {
		await expect(rows).toHaveCount(names.length, { timeout: 20_000 });
		for (const name of names)
			await expect(rows.filter({ hasText: name })).toHaveCount(1);
	};
	/** Values of the Project's data and of the worker's typing. */
	const PRIVATE = [
		searched.caseName,
		searched.answer,
		other.caseName,
		other.answer,
		NOTE,
	];
	const kept: string[] = [];
	const keepEntry = async () => {
		for (const key of await builderKeys(page))
			expect(BUILDER_KEYS).toContain(key);
		kept.push(await entryState(page));
	};

	await openBuilder(page, searchStanding.route);
	const home = new URL(page.url()).pathname;
	await page.getByRole("button", { name: "Preview", exact: true }).click();

	await test.step("the worker searches Patients, chooses the patient and types a note on her form", async () => {
		await menuItem(clinic.name).click({ timeout: 20_000 });
		await menuItem(searching.name).click({ timeout: 20_000 });
		await expectRows([searched.caseName, other.caseName]);
		await main.getByRole("button", { name: "Search again" }).click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
		await searchScreen
			.getByRole("textbox", { name: prompt.label })
			.fill(searched.answer);
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
		await expectRows([searched.caseName]);
		/* The list shows a case's details first; Continue from them holds the
		 * list's form menu on the entry the details stood on. */
		await main
			.getByRole("button", {
				name: new RegExp(`^View details for ${searched.caseName}`),
			})
			.click();
		await main
			.getByRole("button", { name: "Continue", exact: true })
			.click({ timeout: 20_000 });
		await expect(menuTitle).toHaveText(searched.caseName, {
			timeout: 20_000,
		});
		await main
			.getByRole("button", { name: searching.formName, exact: true })
			.click();
		await expect(submit).toBeVisible({ timeout: 20_000 });
		await main
			.getByRole("textbox", { name: SEARCH_STANDING_SEED.noteLabel })
			.fill(NOTE);
		await keepEntry();
	});

	await test.step("Back shows the list's form menu holding the patient, then the list with the worker's search", async () => {
		await page.goBack();
		await expect(menuTitle).toHaveText(searched.caseName, {
			timeout: 20_000,
		});
		await keepEntry();
		await page.goBack();
		await expect(menuTitle).toHaveCount(0, { timeout: 20_000 });
		await expectRows([searched.caseName]);
		await expect(
			main.getByRole("button", { name: "Search again" }),
		).toBeVisible();
		await keepEntry();
	});

	await test.step("every earlier entry back to the app's first holds no value either", async () => {
		for (let step = 0; step < 12; step += 1) {
			if (new URL(page.url()).pathname === home) break;
			await page.goBack();
			await keepEntry();
		}
		expect(new URL(page.url()).pathname).toBe(home);
		for (const state of kept)
			for (const value of PRIVATE) expect(state).not.toContain(value);
	});

	await test.step("Forward returns to the list with the worker's search, and to the menu holding the patient", async () => {
		await page.goForward();
		await expect(menuItem(searching.name)).toBeVisible({ timeout: 20_000 });
		await page.goForward();
		await expectRows([searched.caseName]);
		await page.goForward();
		await expect(menuTitle).toHaveText(searched.caseName, {
			timeout: 20_000,
		});
	});
});
