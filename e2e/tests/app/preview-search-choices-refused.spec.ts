import { readFileSync } from "node:fs";
import type { Route } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { expectBuilderDataLoaded } from "../../lib/pageLoads";
import { removableRoutes } from "../../lib/routes";
import { SEARCH_CHOICES_REFUSED_SEED } from "../../lib/searchChoicesRefusedSeed";

/**
 * A menu that opens on its results whose Region field takes its choices from
 * a table with no rows. Formplayer builds the Search screen's query manager
 * before it runs the automatic search (`QueryScreen.init`), and the manager
 * reads every choice list as it is built
 * (`RemoteQuerySessionManager.refreshItemSetChoices`), so the empty table
 * stops the screen before any search. Preview waits for the table's data
 * before it opens the screen, runs no search meanwhile, and then shows that
 * refusal in place of the results, naming the field and the table: the
 * patient the default search would have found never shows.
 */
test("a menu that opens on its results stops on a search field whose table has no rows", {
	tag: "@seed:search-choices-refused",
}, async ({ scenario, page }) => {
	const { searchChoicesRefused } = seedFor(scenario, "search-choices-refused");
	const seed = SEARCH_CHOICES_REFUSED_SEED;
	test.setTimeout(90_000);
	const main = page.locator("main");

	/* Hold Preview's read of the Project tables, so the screen meets the
	 * moment before they arrive whatever the machine's speed. */
	const manifest = JSON.parse(
		readFileSync(".next/server/server-reference-manifest.json", "utf8"),
	) as { node: Record<string, { filename: string; exportedName: string }> };
	const lookupActionIds = new Set(
		Object.entries(manifest.node)
			.filter(
				([, entry]) =>
					entry.filename === "lib/preview/engine/lookupDataBinding.ts" &&
					entry.exportedName === "loadLookupFixtureDataAction",
			)
			.map(([id]) => id),
	);
	expect(lookupActionIds.size).toBeGreaterThan(0);
	const release = Promise.withResolvers<void>();
	let held = false;
	const lookupRoutes = removableRoutes(page);
	await lookupRoutes.route("**/build/**", async (route: Route) => {
		const actionId = route.request().headers()["next-action"];
		if (!actionId || !lookupActionIds.has(actionId)) return route.continue();
		held = true;
		await release.promise;
		await route.continue();
	});
	try {
		/* Server Actions run one at a time, so the held read holds the Project
		 * catalog read behind it as well, which `openBuilder` waits for.
		 * Preview edits nothing, so it needs no catalog. */
		// biome-ignore lint/plugin/builderPageLoads: this test holds Preview's Project table read, and the catalog read waits behind it.
		await page.goto(searchChoicesRefused.route);
		await page
			.getByRole("button", { name: "Preview", exact: true })
			.click({ timeout: 20_000 });
		await main
			.getByRole("button", { name: new RegExp(`^${seed.moduleName}\\b`) })
			.click({ timeout: 20_000 });

		await test.step("until the table's data arrives, the results wait and no search runs", async () => {
			await expect.poll(() => held, { timeout: 20_000 }).toBe(true);
			await expect(main.locator("[data-search-waiting]")).toHaveText(
				"This search is getting ready.",
				{ timeout: 20_000 },
			);
			await expect(main.getByText(seed.patient.caseName)).toHaveCount(0);
		});
	} finally {
		release.resolve();
		await lookupRoutes.removeAll();
	}
	await expectBuilderDataLoaded(page);

	await test.step("then the search's refusal takes the results' place", async () => {
		const refusal = main.locator('[data-preview-data-refusal="choices"]');
		await expect(refusal).toBeVisible({ timeout: 20_000 });
		await expect(refusal).toHaveAttribute("role", "alert");
		await expect(refusal).toHaveAttribute(
			"data-preview-data-refusal-surface",
			"search",
		);
		await expect(refusal).toContainText(`“${seed.prompt.label}”`);
		await expect(refusal).toContainText(`“${seed.table.name}”`);
		await expect(main.getByText(seed.patient.caseName)).toHaveCount(0);
		await expect(
			main.getByRole("list", { name: "Cases", exact: true }),
		).toHaveCount(0);
	});
});
