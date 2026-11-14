import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

/**
 * Forms in the menu above: a menu's switch in Module settings has it show
 * its forms on the screen above, which Preview then lists in place of the
 * menu's tile. Where the gate refuses the change (a menu that searches), the
 * switch is disabled with the gate's sentence rather than silent.
 */

function menuAboveSwitch(page: Page) {
	return page.getByRole("switch", {
		name: /^Show its forms in the menu above/,
	});
}

test("a menu that shows its forms above lists them on Preview's home screen", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "workspace");
	const main = page.locator("main");

	await openBuilder(page, seed.caseWorkspace.routes.tileModule);
	await expect(main.getByText("Record a visit").first()).toBeVisible({
		timeout: 20_000,
	});
	await page
		.getByRole("button", { name: "Module settings", exact: true })
		.click();
	const section = page.locator("[data-menu-screen]");
	await expect(section).toHaveAttribute("data-menu-screen", "own", {
		timeout: 20_000,
	});
	await expect(
		section.getByText(
			"Workers open Patient tile from the app's first menu, then choose a form.",
		),
	).toBeVisible();
	const toggle = menuAboveSwitch(page);
	await expect(toggle).toBeEnabled();
	const saved = page.waitForResponse((response) => {
		const request = response.request();
		return (
			request.method() === "PUT" &&
			new URL(response.url()).pathname ===
				`/api/apps/${seed.caseWorkspace.appId}` &&
			(request.postData() ?? "").includes('"formsInMenuAbove":true')
		);
	});
	await toggle.click();
	expect((await saved).ok()).toBe(true);
	await expect(toggle).toBeChecked();
	await expect(section).toHaveAttribute("data-menu-screen", "above");
	await expect(
		section.getByText(
			"Patient tile's forms show in the app's first menu, and Patient tile has no entry of its own.",
		),
	).toBeVisible();
	/* The name and appearance stay editable, under the one note. */
	await expect(
		page.locator("[data-menu-screen-kept-note]").first(),
	).toContainText("They're kept for when it has its own screen again.");
	await page.keyboard.press("Escape");

	/* The tree says where the forms show. */
	await expect(page.locator("[data-menu-screen-tree-line]").first()).toHaveText(
		"Forms show in the app's first menu",
	);

	/* The menu has no screen, so Preview runs the screen that lists its
	 * forms: home, with the form in place and no tile for its menu. */
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const homeForm = main.locator("[data-menu-screen-form]", {
		hasText: "Record a visit",
	});
	await expect(homeForm).toBeVisible({ timeout: 20_000 });
	await expect(main.getByRole("button", { name: /^Patient tile/ })).toHaveCount(
		0,
	);
});

test("a menu that searches keeps its screen, and the switch says why", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "workspace");
	await openBuilder(page, seed.caseWorkspace.routes.results);
	await expect(
		page.getByRole("heading", { name: "Results", level: 1 }),
	).toBeVisible({ timeout: 20_000 });
	await page
		.getByRole("button", { name: "Module settings", exact: true })
		.click();
	const toggle = menuAboveSwitch(page);
	await expect(toggle).not.toBeChecked({ timeout: 20_000 });
	await expect(toggle).toBeDisabled();
	await expect(
		page
			.locator("[data-menu-screen]")
			.getByText(/shows its forms in the menu above/),
	).toBeVisible();
});
