import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";

test("Search headings move their fields, survive reload, and collapse in Web Apps Preview", {
	tag: "@seed:workspace",
}, async ({ page, scenario }) => {
	const { caseWorkspace } = seedFor(scenario, "workspace");
	await openBuilder(page, caseWorkspace.routes.search);

	const add = page.getByRole("button", {
		name: "Add Search heading",
		exact: true,
	});
	const labels = page.getByRole("textbox", {
		name: "Search heading",
		exact: true,
	});
	await add.click();
	await expect(labels).toHaveCount(1);
	await labels.first().fill("Identification");
	await labels.first().press("Enter");
	await add.click();
	await expect(labels).toHaveCount(2);
	await labels.last().fill("Visit details");
	await labels.last().press("Enter");
	await page
		.getByRole("combobox", { name: "Move a field to Visit details" })
		.click();
	await page.getByRole("option", { name: "Village", exact: true }).click();

	const saved = page.waitForResponse(
		(response) =>
			response.request().method() === "PUT" &&
			new URL(response.url()).pathname === `/api/apps/${caseWorkspace.appId}` &&
			(response.request().postData() ?? "").includes('"moveSearchInput"'),
	);
	await page
		.getByRole("button", { name: "Move Visit details heading up" })
		.click();
	expect((await saved).ok()).toBe(true);
	await reloadBuilder(page);
	await expect(labels.first()).toHaveValue("Visit details");
	await expect(labels.last()).toHaveValue("Identification");

	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const main = page.locator("main");
	await main.getByRole("button", { name: /^Patients\b/ }).click();
	const search = main.getByRole("search", { name: "Find a patient" });
	const headings = search.locator("summary");
	await expect(headings).toHaveText(["Visit details", "Identification"]);
	const village = search.getByRole("textbox", { name: "Village", exact: true });
	await village.fill("North");
	await headings.first().click();
	await expect(village).toBeHidden();
	await headings.first().click();
	await expect(village).toHaveValue("North");
});
