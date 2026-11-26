import { Client } from "pg";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

test("automatically selects the whole case datum and submits one atomic close", {
	tag: "@seed:automatic-case-selection",
}, async ({ page, scenario }) => {
	const {
		automaticCaseSelection: { appId, caseIds },
	} = seedFor(scenario, "automatic-case-selection");
	await openBuilder(page, `/build/${appId}`);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const menu = (name: string) =>
		page.getByRole("button", { name: `${name} 2 forms`, exact: true });
	const openMenu = (name: string) => menu(name).click();
	await openMenu("No batch cases");
	await expect(
		page.getByRole("heading", { name: "No cases yet" }),
	).toBeVisible();
	await page.goBack();
	await openMenu("Too many batch cases");
	await expect(
		page.getByRole("heading", {
			name: "51 cases match. This list can continue with up to 50.",
		}),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Close group" })).toBeHidden();
	await page.goBack();
	await openMenu("All batch cases");
	await expect(
		page.getByRole("heading", { name: "51 cases selected" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Back", exact: true }).click();
	await expect(menu("All batch cases")).toBeVisible();
	await openMenu("All batch cases");

	await page.getByRole("button", { name: "Close group" }).click();
	await expect(
		page.getByRole("heading", { name: "Close group" }),
	).toBeVisible();
	const db = new Client({ connectionString: process.env.NOVA_DB_LOCAL_URL });
	await db.connect();
	try {
		const saved = async () =>
			(
				await db.query<{ case_id: string }>(
					"SELECT case_id FROM cases WHERE app_id = $1 AND status = 'closed' ORDER BY case_id",
					[appId],
				)
			).rows.map((row) => row.case_id);
		expect(await saved()).toEqual([]);
		await page.getByRole("button", { name: "Submit", exact: true }).click();
		await expect.poll(saved).toEqual(caseIds.toSorted());
	} finally {
		await db.end();
	}
});
