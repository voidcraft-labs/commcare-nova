import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import {
	expectBuilderDataLoaded,
	openBuilder,
	reloadBuilder,
} from "../../lib/pageLoads";
import { removableRoutes } from "../../lib/routes";

async function dismissDeparture(
	page: Page,
	depart: () => Promise<unknown>,
	type = "beforeunload",
) {
	const dialogPromise = page.waitForEvent("dialog");
	// A canceled reload rejects with ERR_ABORTED; join it after dismissing.
	const departure = depart().then(
		() => undefined,
		(error: unknown) => error,
	);
	const dialog = await dialogPromise;
	const actualType = dialog.type();
	await dialog.dismiss();
	expect(actualType).toBe(type);
	const result = await departure;
	if (result !== undefined) expect(String(result)).toContain("ERR_ABORTED");
	expect(page.isClosed()).toBe(false);
}

test("unsaved edits warn on reload, close and leaving through a link, then save after staying", {
	tag: "@seed:member-role",
}, async ({ page, scenario }) => {
	const seed = seedFor(scenario, "member-role");
	await openBuilder(page, `/build/${seed.appId}/${seed.moduleUuid}`);
	// Establish a same-document forward entry through the real Next Link.
	await page.locator('a[href="/"]').first().click();
	await expect(page).toHaveURL(/\/$/);
	await page.goBack();
	await expectBuilderDataLoaded(page);
	const title = page.locator('[data-testid="editable-title"]').visible();
	const routes = removableRoutes(page);
	const release = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const receipt = Promise.withResolvers<void>();
	await routes.route(`**/api/apps/${seed.appId}`, async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		started.resolve();
		await release.promise;
		const response = await route.fetch();
		expect(response.ok()).toBe(true);
		await route.fulfill({ response });
		receipt.resolve();
	});
	try {
		await title.fill("Protected edit");
		await title.press("Enter");
		await started.promise;
		await expect(page.getByText("Saving…", { exact: true })).toBeVisible();
		await dismissDeparture(page, () =>
			page.evaluate(() => {
				// biome-ignore lint/plugin/builderPageLoads: deliberately cancel this native reload; no new document or Project catalog is loaded.
				window.location.reload();
			}),
		);
		await expect(title).toHaveValue("Protected edit");
		await dismissDeparture(
			page,
			() => page.evaluate(() => window.history.forward()),
			"confirm",
		);
		await expect(title).toHaveValue("Protected edit");
		await dismissDeparture(page, () => page.close({ runBeforeUnload: true }));
		await dismissDeparture(page, () =>
			page.locator('a[href="/"]').first().click(),
		);
		await expect(title).toHaveValue("Protected edit");
		release.resolve();
		await receipt.promise;
		await expect(page.getByText(/^Saved just now$/)).toBeVisible();
		// A fresh read must contain the saved edit and must no longer warn.
		await reloadBuilder(page);
		await expect(title).toHaveValue("Protected edit");
	} finally {
		release.resolve();
		await routes.removeAll();
	}
});

test("an edit waiting in the autosave cooldown is visibly unsaved and protects departure", {
	tag: "@seed:member-role",
}, async ({ page, scenario }) => {
	const seed = seedFor(scenario, "member-role");
	await openBuilder(page, `/build/${seed.appId}/${seed.moduleUuid}`);
	await page.clock.install();
	await page.clock.pauseAt(new Date());
	const title = page.locator('[data-testid="editable-title"]').visible();
	try {
		await title.fill("First receipt");
		await title.press("Enter");
		await expect(page.getByText(/^Saved just now$/)).toBeVisible();
		await title.fill("Queued in cooldown");
		await title.press("Enter");
		await expect(page.getByText("Saving…", { exact: true })).toBeVisible();
		await dismissDeparture(page, () =>
			page.evaluate(() => {
				// biome-ignore lint/plugin/builderPageLoads: deliberately cancel this native reload; no new document or Project catalog is loaded.
				window.location.reload();
			}),
		);
		await expect(title).toHaveValue("Queued in cooldown");
		await page.clock.runFor(1000);
		await expect(page.getByText(/^Saved just now$/)).toBeVisible();
		await reloadBuilder(page);
		await expect(title).toHaveValue("Queued in cooldown");
	} finally {
		await page.clock.resume();
	}
});
