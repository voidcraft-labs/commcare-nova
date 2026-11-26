import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";

test("a search name can be corrected and is kept when the menu reopens", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const { caseWorkspace } = seedFor(scenario, "workspace");
	await openBuilder(page, caseWorkspace.routes.tileModule);
	const settings = page.getByRole("button", {
		name: "Module settings",
		exact: true,
	});
	await settings.click();
	const field = page.getByRole("textbox", { name: "Search results name" });
	await field.fill("2Family");
	await field.press("Enter");
	await expect(field).toBeFocused();
	await expect(field).toHaveValue("2Family");
	await expect(field).toHaveAttribute("aria-invalid", "true");
	await expect(
		page.getByRole("alert").filter({ hasText: "Choose a name" }),
	).toBeVisible();

	const saved = page.waitForResponse(
		(response) =>
			response.request().method() === "PUT" &&
			new URL(response.url()).pathname === `/api/apps/${caseWorkspace.appId}` &&
			(response.request().postData() ?? "").includes(
				'"searchResultsName":"Famille2"',
			),
	);
	await field.fill("Famille2");
	await field.press("Enter");
	expect((await saved).ok()).toBe(true);
	await reloadBuilder(page);
	await settings.click();
	await expect(field).toHaveValue("Famille2");
	await expect(field).toHaveAttribute("aria-invalid", "false");
});
