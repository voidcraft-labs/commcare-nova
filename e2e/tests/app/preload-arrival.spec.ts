import { expect, seedFor, test } from "../../lib/appFixtures";

test("a later identical case read preserves the open calendar and native control identity", {
	tag: "@seed:workspace",
}, async ({ page, scenario }) => {
	page.setDefaultTimeout(15_000);
	const seed = seedFor(scenario, "workspace");
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
		await expect(date).toHaveText(/June 21, 2026/);
		await expect.poll(() => arrived).toBe(true);
		const original = await date.elementHandle();
		if (!original) throw new Error("Missing date control");
		await date.click();
		const clear = page.getByRole("button", { name: "Clear", exact: true });
		await expect(clear).toBeVisible();
		release.resolve();
		await expect.poll(() => delivered).toBe(true);
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
