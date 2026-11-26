import type { Locator, Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";

async function choose(page: Page, control: Locator, name: string) {
	await control.click();
	await page.getByRole("option", { name, exact: true }).click();
}

test("online search keeps its server order and search-only owners when the builder reopens", {
	tag: "@seed:workspace",
}, async ({ page, scenario }) => {
	const { caseWorkspace } = seedFor(scenario, "workspace");
	await openBuilder(page, caseWorkspace.routes.results);
	const online = page.getByRole("button", {
		name: "Online search",
		exact: true,
	});
	await online.click();
	const filters = page.getByRole("region", { name: "Search filters" });
	const order = filters.getByRole("group", {
		name: "Which matches arrive first",
	});
	await order.getByRole("button", { name: "Choose order" }).click();
	await choose(
		page,
		order.getByRole("combobox", { name: "Order property 1" }),
		"Last visit",
	);
	await choose(
		page,
		order.getByRole("combobox", { name: "Compare property 1 as" }),
		"Date",
	);
	await choose(
		page,
		order.getByRole("combobox", { name: "Direction for property 1" }),
		"Descending",
	);

	await filters
		.getByRole("button", { name: "Add search filter", exact: true })
		.click();
	await choose(
		page,
		filters.getByRole("combobox", { name: "Information to match" }),
		"Owners to leave out of Search",
	);
	await filters
		.getByRole("textbox", { name: "Value to match" })
		.fill("retired-team");
	const [saved] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.request().method() === "PUT" &&
				new URL(response.url()).pathname ===
					`/api/apps/${caseWorkspace.appId}` &&
				(response.request().postData() ?? "").includes("retired-team"),
		),
		filters.getByRole("button", { name: "Add filter", exact: true }).click(),
	]);
	expect(saved.ok()).toBe(true);
	await reloadBuilder(page);
	await online.click();
	await expect(
		order.getByRole("combobox", { name: "Order property 1" }),
	).toContainText("Last visit");
	await expect(
		order.getByRole("combobox", { name: "Compare property 1 as" }),
	).toContainText("Date");
	await expect(
		order.getByRole("combobox", { name: "Direction for property 1" }),
	).toContainText("Descending");
	await expect(
		filters.getByRole("combobox", { name: "Information to match" }),
	).toContainText("Owners to leave out of Search");
});
