import { expect, seedFor, test } from "../../lib/appFixtures";
import { pressTrailCrumb } from "../../lib/breadcrumbTrail";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";
import { SEARCH_CLAIM_SEED } from "../../lib/previewRuntimeSeeds";
import { removableRoutes } from "../../lib/routes";

/**
 * A search reads past the worker's device, so it can find a record another
 * worker owns. Choosing it claims it, as CommCare does, and the form then
 * opens with that record's saved values. Results read the search's own
 * population, so they carry no note about records left off the device. The
 * claim is a case row, so a reload keeps it on the worker's device until the
 * identity menu's Release claimed cases closes it.
 */
test("a searched record another persona owns opens its form with its case data, and its claim lasts until released", {
	tag: "@seed:search-claim",
}, async ({ scenario, page }) => {
	const { searchClaim } = seedFor(scenario, "search-claim");
	const { searcher, match, prompt, moduleName, formName, noteLabel } =
		SEARCH_CLAIM_SEED;
	test.setTimeout(90_000);
	const main = page.locator("main");
	const identity = page
		.locator("[data-app-header]")
		.getByRole("button", { name: /Running as/ });
	const searchScreen = main.getByRole("search", { name: "Search" });
	const rows = main
		.getByRole("list", { name: "Cases", exact: true })
		.getByRole("listitem");

	await openBuilder(page, searchClaim.route);
	await expect(
		page.getByRole("button", { name: "Preview", exact: true }),
	).toBeVisible({ timeout: 20_000 });
	await page.getByRole("button", { name: "Preview", exact: true }).click();

	await test.step(`Preview runs as ${searcher.name}, who owns no records`, async () => {
		await identity.click();
		await page
			.getByRole("menuitemradio", {
				name: new RegExp(`^Preview as ${searcher.name}\\b`),
			})
			.click();
		await expect(identity).toHaveAccessibleName(
			new RegExp(`Running as ${searcher.name}\\b`),
		);
	});

	await test.step("the search finds the record another persona owns, with no restore note", async () => {
		await main
			.getByRole("button", { name: new RegExp(`^${moduleName}\\b`) })
			.click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
		await searchScreen
			.getByRole("textbox", { name: prompt.label })
			.fill(match.caseName);
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
		await expect(rows).toHaveCount(1, { timeout: 20_000 });
		await expect(rows.first()).toContainText(match.caseName);
		await expect(main.getByText(/would not be on .* device/)).toHaveCount(0);
	});

	await test.step("a claim that lands after the worker went Home leaves them there", async () => {
		/* The menu's forms read the search, so the claim posts as the form is
		 * chosen and the form opens once it lands. Home meanwhile is where the
		 * worker went: the late claim opens nothing over it. */
		const form = main.getByRole("button", { name: formName, exact: true });
		const release = Promise.withResolvers<void>();
		let arrived = false;
		let delivered = false;
		const claimRoutes = removableRoutes(page);
		await claimRoutes.route("**/build/**", async (route) => {
			const request = route.request();
			if (request.method() !== "POST" || !request.headers()["next-action"])
				return route.continue();
			const args: unknown = request.postDataJSON();
			const claim =
				Array.isArray(args) && args.length === 1 ? args[0] : undefined;
			if (
				typeof claim !== "object" ||
				claim === null ||
				!Array.isArray((claim as { caseIds?: unknown }).caseIds) ||
				"caseType" in claim
			)
				return route.continue();
			const response = await route.fetch();
			arrived = true;
			await release.promise;
			await route.fulfill({ response });
			delivered = true;
		});
		try {
			await main
				.getByRole("button", {
					name: new RegExp(`^View details for ${match.caseName}`),
				})
				.click();
			await main.getByRole("button", { name: "Continue", exact: true }).click();
			await form.click();
			await expect.poll(() => arrived).toBe(true);
			await pressTrailCrumb(page, "Home");
			const moduleTile = main.getByRole("button", {
				name: new RegExp(`^${moduleName}\\b`),
			});
			await expect(moduleTile).toBeVisible({ timeout: 20_000 });
			release.resolve();
			await expect.poll(() => delivered).toBe(true);
			/* The claim has landed once the identity menu counts it. */
			await identity.click();
			await expect(
				page.getByRole("menuitem", {
					name: "Release 1 claimed case",
					exact: true,
				}),
			).toBeVisible({ timeout: 20_000 });
			await page.keyboard.press("Escape");
			await expect(moduleTile).toBeVisible();
			await expect(
				main.getByRole("button", { name: "Submit", exact: true }),
			).toHaveCount(0);
			await expect(form).toHaveCount(0);
		} finally {
			release.resolve();
			await claimRoutes.removeAll();
		}
		/* History still holds the menu holding the record behind Home. */
		await page.goBack();
		await expect(form).toBeVisible({ timeout: 20_000 });
		await expect(
			main.getByRole("button", { name: "Submit", exact: true }),
		).toHaveCount(0);
		/* Search for the record again from Home. */
		await pressTrailCrumb(page, "Home");
		await main
			.getByRole("button", { name: new RegExp(`^${moduleName}\\b`) })
			.click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
		await searchScreen
			.getByRole("textbox", { name: prompt.label })
			.fill(match.caseName);
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
		await expect(rows).toHaveCount(1, { timeout: 20_000 });
		await expect(rows.first()).toContainText(match.caseName);
	});

	await test.step("choosing it opens the form with its saved values", async () => {
		await main
			.getByRole("button", {
				name: new RegExp(`^View details for ${match.caseName}`),
			})
			.click();
		await main.getByRole("button", { name: "Continue", exact: true }).click();
		/* CommCare lists the menu's one form once the record is chosen. */
		await main.getByRole("button", { name: formName, exact: true }).click();
		const note = main.getByRole("textbox", {
			name: new RegExp(`${noteLabel}$`),
		});
		await expect(note).toHaveValue(match.lastNote, { timeout: 20_000 });
		await expect(
			main.getByRole("button", { name: "Submit", exact: true }),
		).toBeEnabled();
	});

	const runAsSearcher = async () => {
		await identity.click();
		await page
			.getByRole("menuitemradio", {
				name: new RegExp(`^Preview as ${searcher.name}\\b`),
			})
			.click();
		await expect(identity).toHaveAccessibleName(
			new RegExp(`Running as ${searcher.name}\\b`),
		);
	};
	const releaseOne = page.getByRole("menuitem", {
		name: "Release 1 claimed case",
		exact: true,
	});

	await test.step("after a reload the claimed record is still on the worker's device", async () => {
		await reloadBuilder(page);
		await expect(
			page.getByRole("button", { name: "Preview", exact: true }),
		).toBeVisible({ timeout: 20_000 });
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await runAsSearcher();
		await identity.click();
		await expect(releaseOne).toBeVisible({ timeout: 20_000 });
	});

	await test.step("Release claimed cases takes the record off the device", async () => {
		await releaseOne.click();
		await expect(
			page.getByText("Released 1 case this worker claimed from a search"),
		).toBeVisible({ timeout: 20_000 });
		await identity.click();
		await expect(page.getByRole("group", { name: "Running as" })).toBeVisible();
		await expect(
			page.getByRole("menuitem", { name: /^Release \d+ claimed/ }),
		).toHaveCount(0);
		await page.keyboard.press("Escape");
	});
});
