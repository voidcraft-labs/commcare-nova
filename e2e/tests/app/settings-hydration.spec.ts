import { expect, seedFor, test } from "../../lib/appFixtures";

test.use({ timezoneId: "America/Denver" });

test("Settings hydrates across time zones and clock skew", {
	tag: "@seed:settings",
}, async ({ page, scenario }) => {
	const seed = seedFor(scenario, "settings");
	// Keep native timers running while making relative labels differ from the server.
	await page.clock.setFixedTime(
		new Date(new Date(seed.lastUsedAt).getTime() + 2 * 60 * 60 * 1000),
	);
	const response = await page.goto("/settings");
	expect(response).not.toBeNull();
	const html = await response?.text();
	expect(html).toContain("2 Jan 2026");
	await expect(
		page.getByText("Authorized 1 Jan 2026", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Last used 2 hours ago", { exact: true }),
	).toBeVisible();
	// The shared fixture rejects hydration errors and browser error reports.
});
