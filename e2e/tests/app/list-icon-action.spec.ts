import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";

test("a Results icon updates only the clicked record and returns to the list", {
	tag: "@seed:list-icon-action",
}, async ({ page, scenario }) => {
	const { listIconAction: fixture } = seedFor(scenario, "list-icon-action");
	// Serve this Project's seeded image in place of its object store.
	await page.route(`**/api/media/${fixture.assetId}`, (route) =>
		route.fulfill({
			contentType: "image/png",
			body: Buffer.from(fixture.bytes, "base64"),
		}),
	);
	await openBuilder(page, fixture.route);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const row = (name: string) =>
		page.locator("main [data-case-result-row]").filter({ hasText: name });
	const first = row("First visit");
	const second = row("Second visit");
	const action = (item: typeof first) =>
		item.getByRole("button", { name: "Record visit", exact: true });
	await expect(action(first)).toBeEnabled();
	await expect(first.getByText("ready", { exact: true })).toBeVisible();
	await expect(second.getByText("ready", { exact: true })).toBeVisible();
	await action(second).click();
	await expect(second.getByText("visited", { exact: true })).toBeVisible({
		timeout: 20_000,
	});
	await expect(action(second)).toHaveCount(0);
	await expect(action(first)).toBeEnabled();
	await expect(first.getByText("ready", { exact: true })).toBeVisible();
	await reloadBuilder(page);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(second.getByText("visited", { exact: true })).toBeVisible({
		timeout: 20_000,
	});
	await expect(first.getByText("ready", { exact: true })).toBeVisible();
});
