import { expect, seedFor, test } from "../../lib/appFixtures";
import { caseWorkspaceCaseRows } from "../../lib/caseWorkspaceSeed";

test("Preview opened from Edit waits for its raw preload before showing defaults", {
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
	// Hold the real raw-row Server Action result. The case tile's separate read
	// includes its column configuration; the form requests only raw preloads.
	await page.route("**/build/**", async (route) => {
		const request = route.request();
		if (request.method() !== "POST" || !request.headers()["next-action"])
			return route.continue();
		const args: unknown = request.postDataJSON();
		if (
			!Array.isArray(args) ||
			args[0] !== seed.caseWorkspace.appId ||
			args[1] !== seed.caseWorkspace.caseType ||
			typeof args[2] !== "string" ||
			args[4] !== "$undefined" ||
			args[9] !== true
		)
			return route.continue();
		const response = await route.fetch();
		arrived = true;
		await release.promise;
		await route.fulfill({ response });
		delivered = true;
	});
	try {
		await page.goto(seed.caseWorkspace.routes.tileForm);
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const date = page.locator('button[data-slot="date-picker"]');
		await expect.poll(() => arrived).toBe(true);
		await expect(date).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Submit", exact: true }),
		).toBeDisabled();
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
		await page.unrouteAll({ behavior: "wait" });
	}
});
