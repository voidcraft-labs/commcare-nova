import { expect, seedFor, test } from "../../lib/appFixtures";
import { CASE_WORKSPACE_SEED } from "../../lib/caseWorkspaceSeed";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";

test("an author adds a tab of table records and reopens its saved layout", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const { caseWorkspace } = seedFor(scenario, "workspace");
	await openBuilder(page, caseWorkspace.routes.details);
	await page.getByRole("button", { name: "Group fields into tabs" }).click();
	const dialog = page.getByRole("dialog", { name: "Detail tabs" });
	await dialog.getByRole("button", { name: "Add a tab" }).click();
	const newTitle = dialog.getByRole("textbox", { name: "Tab title" }).last();
	await expect(newTitle).toBeFocused();
	await newTitle.fill("Places to refer");
	const tab = dialog.getByRole("group", { name: "Places to refer" });
	await tab.getByRole("combobox", { name: "Records in this tab" }).click();
	await page
		.getByRole("option", {
			name: CASE_WORKSPACE_SEED.lookupTableName,
			exact: true,
		})
		.click();
	await tab.getByRole("combobox", { name: "Add a table field" }).click();
	const firstColumn = page.getByRole("option").first();
	const label = (await firstColumn.innerText()).trim();
	await firstColumn.click();
	await expect(
		tab.getByRole("button", { name: `Remove ${label}`, exact: true }),
	).toBeVisible();
	const [saved] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.request().method() === "PUT" &&
				new URL(response.url()).pathname ===
					`/api/apps/${caseWorkspace.appId}` &&
				(response.request().postData() ?? "").includes("Places to refer"),
		),
		dialog.getByRole("button", { name: "Save tabs" }).click(),
	]);
	expect(saved.ok()).toBe(true);
	await reloadBuilder(page);
	await page.getByRole("button", { name: "Edit tabs" }).click();
	const reopened = dialog.getByRole("group", { name: "Places to refer" });
	await expect(
		reopened.getByRole("combobox", { name: "Records in this tab" }),
	).toHaveText(CASE_WORKSPACE_SEED.lookupTableName);
	await expect(
		reopened.getByRole("combobox", { name: `Tab for ${label}`, exact: true }),
	).toHaveText("Places to refer");
});
