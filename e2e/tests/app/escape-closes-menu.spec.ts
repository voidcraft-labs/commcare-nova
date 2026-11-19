import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

/**
 * An open menu takes Escape before the builder does. The builder's Escape
 * leaves Preview, and a menu open in Preview closes on Escape, so one press
 * must close the menu and leave Preview running: the keyboard manager hears a
 * key only after the open popup has had it, and leaves alone the one it took.
 * Both a menu of the running app (the case list's Sort by) and a menu of the
 * builder's own chrome (Running as) are held to it.
 */
test("Escape closes an open menu in Preview and Preview keeps running", {
	tag: "@seed:sort-by",
}, async ({ scenario, page }) => {
	const { sortBy } = seedFor(scenario, "sort-by");
	test.setTimeout(90_000);
	const main = page.locator("main");
	const backToEdit = page.getByRole("button", { name: "Back to edit" });
	const identity = page.getByRole("button", { name: /^Running as / });

	await openBuilder(page, sortBy.route);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(backToEdit).toBeVisible({ timeout: 20_000 });
	const sortMenu = main.getByRole("button", { name: "Sort by", exact: true });
	await expect(sortMenu).toBeVisible({ timeout: 20_000 });

	await test.step("the case list's Sort by closes and Preview stays", async () => {
		await sortMenu.click();
		await expect(page.getByRole("menu")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menu")).toHaveCount(0);
		await expect(backToEdit).toBeVisible();
		await expect(sortMenu).toBeVisible();
	});

	await test.step("the Running as menu closes and Preview stays", async () => {
		await identity.click();
		await expect(page.getByRole("menu")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menu")).toHaveCount(0);
		await expect(backToEdit).toBeVisible();
		await expect(sortMenu).toBeVisible();
	});

	await test.step("with no menu open, Escape leaves Preview", async () => {
		await expect(page.getByRole("menu")).toHaveCount(0);
		// A tooltip is a floating element too, and takes Escape first: the
		// pointer leaves the trigger it rests on and focus leaves the trigger
		// the menu returned it to, so no tooltip is open.
		await page.mouse.move(8, 700);
		await page.evaluate(() => {
			const active = document.activeElement;
			if (active instanceof HTMLElement) active.blur();
		});
		await expect(page.getByRole("tooltip")).toHaveCount(0);
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("button", { name: "Preview", exact: true }),
		).toBeVisible();
	});
});
