import { Pool } from "pg";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { createSmokeContext } from "../../lib/smokeNetwork";

test("a referral opens the shared questions and submits to the first chosen person", {
	tag: "@seed:shared-form-entries",
}, async ({ scenario, page, browser, baseURL }) => {
	const { appId, people, entryUuid, parentUuid } = seedFor(
		scenario,
		"shared-form-entries",
	);
	const parentRoute = `/build/${appId}/${parentUuid}`;
	const sharedRoute = `/build/${appId}/${entryUuid}`;
	const settingsButton = page.getByRole("button", {
		name: "Form settings",
		exact: true,
	});
	const settings = page
		.getByRole("dialog")
		.filter({ hasText: "Form settings" });
	const rootInput = settings.getByRole("textbox", {
		name: "Submitted answer root",
	});
	const root = "shared_visit";
	await openBuilder(page, parentRoute);
	await settingsButton.click();
	await settings
		.getByText("Submitted answer addresses", { exact: true })
		.click();
	await rootInput.fill(root);
	const [savedRoot] = await Promise.all([
		page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === `/api/apps/${appId}` &&
				response.request().method() === "PUT" &&
				response.request().postData()?.includes('"dataRootName"') === true,
		),
		rootInput.press("Enter"),
	]);
	expect(savedRoot.ok()).toBe(true);

	await openBuilder(page, sharedRoute);
	await settingsButton.click();
	await expect(settings.getByText(root, { exact: true })).toBeVisible();
	await expect(rootInput).toHaveCount(0);

	const viewerContext = await createSmokeContext(browser, {
		baseURL,
		storageState: scenario.common.viewerStorageState,
	});
	try {
		const viewer = await viewerContext.newPage();
		await openBuilder(viewer, sharedRoute);
		await viewer
			.getByRole("button", { name: "Form settings", exact: true })
			.click();
		const viewerSettings = viewer
			.getByRole("dialog")
			.filter({ hasText: "Form settings" });
		await expect(viewerSettings.getByText(root, { exact: true })).toBeVisible();
		await expect(
			viewerSettings.getByRole("textbox", { name: "Submitted answer root" }),
		).toHaveCount(0);
	} finally {
		await viewerContext.close();
	}

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
	await expect(page).toHaveURL(
		(url) => url.pathname === `${sharedRoute}/operations`,
	);
	const openingChoices = page.locator("section").filter({
		has: page.getByRole("heading", { name: "Shared form", exact: true }),
	});
	await openingChoices
		.getByRole("button", { name: "Open shared questions", exact: true })
		.click();
	await expect(page).toHaveURL((url) => url.pathname === parentRoute);
	await openBuilder(page, `/build/${appId}`);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const main = page.locator("main");
	await main.getByRole("button", { name: /^People\b/ }).click();
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
	await expect(settingsButton).toHaveCount(0);
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
