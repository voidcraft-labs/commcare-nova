import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { CASE_WORKSPACE_SEED } from "../../lib/caseWorkspaceSeed";
import { openBuilder } from "../../lib/pageLoads";

/**
 * Case list in the menu: a menu lists its case list as an entry of its own,
 * after its forms (`Module.caseListMenuItem`). Beside forms the entry is the
 * author's choice; a menu that is only its case list keeps it, and the switch
 * says why.
 */

const BARE_LINE =
	"This menu has no forms, so the case list is what it opens. Once it has a form, you can turn this off.";

function menuItemSwitch(page: Page) {
	return page.getByRole("switch", {
		name: /^Show the case list in this menu/,
	});
}

test("turning on the case list in a menu with forms lists it after the forms", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "workspace");
	const main = page.locator("main");
	const entry = main.locator("[data-case-list-menu-entry]");

	await openBuilder(page, seed.caseWorkspace.routes.tileModule);
	await expect(main.getByText("Record a visit").first()).toBeVisible({
		timeout: 20_000,
	});
	await expect(entry).toHaveCount(0);

	await page
		.getByRole("button", { name: "Module settings", exact: true })
		.click();
	const toggle = menuItemSwitch(page);
	await expect(toggle).not.toBeChecked({ timeout: 20_000 });
	await expect(toggle).toBeEnabled();
	const saved = page.waitForResponse((response) => {
		const request = response.request();
		return (
			request.method() === "PUT" &&
			new URL(response.url()).pathname ===
				`/api/apps/${seed.caseWorkspace.appId}` &&
			(request.postData() ?? "").includes('"kind":"setCaseListMenuItem"')
		);
	});
	await toggle.click();
	expect((await saved).ok()).toBe(true);
	await expect(toggle).toBeChecked();
	// The entry's label takes the module's name until one is written.
	await expect(
		page.getByRole("textbox", { name: "Menu item label" }),
	).toHaveAttribute("placeholder", "Patient tile");
	await page.keyboard.press("Escape");

	// The module screen keeps its forms and lists the case list after them.
	await expect(entry).toHaveCount(1);
	await expect(entry).toContainText("Patient tile");
	const menuButtons = entry.locator("xpath=..").locator(":scope > button");
	await expect(menuButtons.last()).toHaveAttribute("data-case-list-menu-entry");
	await expect(menuButtons.first()).toContainText("Record a visit");

	// The entry opens the module's case list.
	await entry.click();
	await expect(page).toHaveURL(
		new RegExp(`/${CASE_WORKSPACE_SEED.tile.moduleUuid}/results$`),
	);
});

test("a menu that is only its case list keeps the entry, and says why", {
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
	const toggle = menuItemSwitch(page);
	await expect(toggle).toBeChecked({ timeout: 20_000 });
	await expect(toggle).toBeDisabled();
	await expect(
		page.locator("[data-case-list-menu-item]").getByText(BARE_LINE),
	).toBeVisible();
});
