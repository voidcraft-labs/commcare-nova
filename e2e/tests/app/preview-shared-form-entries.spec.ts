import { Pool } from "pg";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

test("a referral opens the shared questions and submits to the first chosen person", {
	tag: "@seed:shared-form-entries",
}, async ({ scenario, page }) => {
	const { appId, people, entryUuid, parentUuid } = seedFor(
		scenario,
		"shared-form-entries",
	);
	await openBuilder(page, `/build/${appId}/${entryUuid}`);
	await page
		.getByRole("button", { name: "Form settings", exact: true })
		.click();
	const finish = "Complete referral";
	const label = page.getByRole("textbox", {
		name: "Submit button in Web Apps",
		exact: true,
	});
	await label.fill(finish);
	const [saved] = await Promise.all([
		page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === `/api/apps/${appId}` &&
				response.request().method() === "PUT" &&
				(response.request().postData() ?? "").includes(finish),
		),
		label.press("Enter"),
	]);
	expect(saved.ok()).toBe(true);
	await page
		.getByRole("button", { name: "Close form settings", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Edit opening choices", exact: true })
		.click();
	await page.getByRole("button", { name: "Open shared questions" }).click();
	await expect(page).toHaveURL(new RegExp(parentUuid));
	await openBuilder(page, `/build/${appId}`);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const main = page.locator("main");
	await main.getByRole("button", { name: "People", exact: true }).click();
	await main
		.getByRole("button", { name: "Follow a referral", exact: true })
		.click();
	for (const [index, title] of [
		"Person receiving care",
		"Contact person",
		"Referring person",
	].entries()) {
		const list = main.getByRole("region", { name: title, exact: true });
		await list
			.getByRole("button", {
				name: new RegExp(`^View details for ${people[index]}\\b`),
			})
			.click();
		await list.getByRole("button", { name: "Continue", exact: true }).click();
	}
	const value = "Follow up at home";
	await main.getByRole("textbox", { name: "Visit note" }).fill(value);
	await main.getByRole("button", { name: finish, exact: true }).click();
	const connectionString = process.env.NOVA_DB_LOCAL_URL;
	if (!connectionString)
		throw new Error("This journey needs the local smoke database.");
	const pool = new Pool({ connectionString });
	try {
		await expect
			.poll(
				async () =>
					(
						await pool.query(
							"SELECT case_name, properties->>'visit_note' AS note FROM cases WHERE app_id=$1 AND case_type='person' ORDER BY case_name",
							[appId],
						)
					).rows,
			)
			.toEqual(
				people.map((name, index) => ({
					case_name: name,
					note: index === 0 ? value : null,
				})),
			);
	} finally {
		await pool.end();
	}
});
