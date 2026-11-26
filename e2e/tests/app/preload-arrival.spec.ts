import { expect, seedFor, test } from "../../lib/appFixtures";
import { caseWorkspaceCaseRows } from "../../lib/caseWorkspaceSeed";
import { openBuilder } from "../../lib/pageLoads";
import { removableRoutes } from "../../lib/routes";

test("Preview opened from Edit waits for its signed opening before showing defaults", {
	tag: "@seed:workspace",
}, async ({ page, scenario }) => {
	page.setDefaultTimeout(15_000);
	const seed = seedFor(scenario, "workspace");
	/* With no case in hand, Preview binds the form to the first case a read
	 * with no order plan returns: the lowest case id. The seed keeps each
	 * inserted id at its row's index, and that row's visit started on its
	 * last visit date, which is the date the preloaded default shows. */
	const caseIds = seed.caseWorkspace.caseIds;
	const boundCaseId = caseIds.toSorted()[0];
	const boundProperties =
		caseWorkspaceCaseRows()[caseIds.indexOf(boundCaseId ?? "")]?.properties;
	const lastVisit =
		typeof boundProperties === "object"
			? boundProperties.last_visit
			: undefined;
	if (typeof lastVisit !== "string")
		throw new Error("The workspace seed holds no case for Preview to bind");
	const preloadedDate = new Date(`${lastVisit}T00:00:00Z`).toLocaleDateString(
		"en-US",
		{ dateStyle: "long", timeZone: "UTC" },
	);
	const release = Promise.withResolvers<void>();
	let arrived = false;
	let delivered = false;
	// Hold the real signed-opening Server Action result: a form that reads its
	// case opens on the signed snapshot of the records it reads, which carries
	// the preloaded values (`formOpeningAction.ts`). Its first argument is the
	// opening request, the only action argument naming a blueprint digest.
	const actionRoutes = removableRoutes(page);
	await actionRoutes.route("**/build/**", async (route) => {
		const request = route.request();
		if (request.method() !== "POST" || !request.headers()["next-action"])
			return route.continue();
		const args: unknown = request.postDataJSON();
		const opening: unknown = Array.isArray(args) ? args[0] : undefined;
		if (
			typeof opening !== "object" ||
			opening === null ||
			(opening as { app?: unknown }).app !== seed.caseWorkspace.appId ||
			typeof (opening as { blueprintDigest?: unknown }).blueprintDigest !==
				"string" ||
			(opening as { previous?: unknown }).previous !== undefined
		)
			return route.continue();
		const response = await route.fetch();
		arrived = true;
		await release.promise;
		await route.fulfill({ response });
		delivered = true;
	});
	try {
		await openBuilder(page, seed.caseWorkspace.routes.tileForm);
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const date = page.locator('button[data-slot="date-picker"]');
		await expect.poll(() => arrived).toBe(true);
		// The form waits for its opening: no question and no Submit yet.
		await expect(date).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Submit", exact: true }),
		).toHaveCount(0);
		release.resolve();
		await expect.poll(() => delivered).toBe(true);
		await expect(date).toContainText(preloadedDate);
		const original = await date.elementHandle();
		if (!original) throw new Error("Missing date control");
		await date.click();
		const clear = page.getByRole("button", { name: "Clear", exact: true });
		await expect(clear).toBeVisible();
		await clear.click();
		await expect(date).toHaveText(/Pick a date/);
		expect(await original.evaluate((element) => element.isConnected)).toBe(
			true,
		);
	} finally {
		release.resolve();
		await actionRoutes.removeAll();
	}
});
