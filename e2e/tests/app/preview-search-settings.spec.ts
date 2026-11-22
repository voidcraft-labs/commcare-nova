import { Pool } from "pg";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { createSmokeContext } from "../../lib/smokeNetwork";

test("shares a confirmed local search profile across signed-in tabs and lets a stale editor recover", {
	tag: "@seed:app-tests",
}, async ({ scenario, page, context, browser, baseURL }) => {
	const { appId } = seedFor(scenario, "app-tests");
	async function openSettings(tab: typeof page) {
		await openBuilder(tab, `/build/${appId}`);
		await tab.getByRole("button", { name: "Preview", exact: true }).click();
		await tab.getByRole("button", { name: /Running as/ }).click();
		await tab
			.getByRole("menuitem", { name: "Preview search settings", exact: true })
			.click();
		const dialog = tab.getByRole("dialog", { name: "Preview search settings" });
		await expect(dialog).toContainText("500-record limit.");
		await dialog.getByRole("combobox", { name: "Search destination" }).click();
		await tab.getByRole("option", { name: "Local Preview" }).click();
		return dialog;
	}
	const peer = await context.newPage();
	const viewer = await createSmokeContext(browser, {
		baseURL,
		storageState: scenario.common.viewerStorageState,
	});
	try {
		const first = await openSettings(page);
		const second = await openSettings(peer);
		const viewing = await openSettings(await viewer.newPage());
		await expect(viewing.getByLabel("Project space time zone")).toBeDisabled();
		await expect(viewing.getByLabel("Project space time zone")).toHaveValue(
			"UTC",
		);
		await expect(
			viewing.getByRole("button", { name: "Save settings" }),
		).toHaveCount(0);
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"UTC",
		);
		// The viewer and the untouched editor both follow this revision.
		await first.getByLabel("Project space time zone").fill("Europe/Paris");
		await first.getByRole("button", { name: "Save settings" }).click();
		await expect(first).toBeHidden();
		await expect(viewing.getByLabel("Project space time zone")).toHaveValue(
			"Europe/Paris",
		);
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"Europe/Paris",
		);
		await second.getByLabel("Project space time zone").fill("Asia/Kolkata");
		await page.getByRole("button", { name: /Running as/ }).click();
		await page
			.getByRole("menuitem", { name: "Preview search settings", exact: true })
			.click();
		await first.getByLabel("Project space time zone").fill("Europe/Berlin");
		await first.getByRole("button", { name: "Save settings" }).click();
		await expect(first).toBeHidden();
		await expect(viewing.getByLabel("Project space time zone")).toHaveValue(
			"Europe/Berlin",
		);
		await expect(second).toContainText("A teammate updated these settings");
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"Asia/Kolkata",
		);
		await expect(
			second.getByRole("button", { name: "Save settings" }),
		).toBeDisabled();
		await second.getByText("Review team settings").click();
		await expect(second.getByRole("status")).toContainText("Europe/Berlin");
		await second.getByRole("button", { name: "Use latest settings" }).click();
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"Europe/Berlin",
		);
		await expect(second).toContainText("Supplied by your team");
	} finally {
		await viewer.close();
		await peer.close();
	}
});

test("edits one setting in a saved profile larger than the action limit and preserves every rule", {
	tag: "@seed:app-tests",
}, async ({ scenario, page }) => {
	const { appId } = seedFor(scenario, "app-tests");
	const connectionString = process.env.NOVA_DB_LOCAL_URL;
	if (!connectionString) throw new Error("The smoke database is required.");
	const pool = new Pool({ connectionString });
	const ignoredText = Array.from({ length: 4100 }, (_, i) => ({
		caseType: "person",
		property: "badge",
		literal: String(i).padStart(256, "x"),
	}));
	const initial = {
		maximum: 500,
		timeZone: "UTC",
		propertyMatchers: { fuzzyProperties: [], ignoredText },
	};
	try {
		await pool.query(
			`INSERT INTO preview_search_settings(project_id,server,domain,revision,settings)
		SELECT project_id,'local','',1,$2::jsonb FROM apps WHERE id=$1`,
			[appId, JSON.stringify(initial)],
		);
		await openBuilder(page, `/build/${appId}`);
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await page.getByRole("button", { name: /Running as/ }).click();
		await page
			.getByRole("menuitem", { name: "Preview search settings", exact: true })
			.click();
		const dialog = page.getByRole("dialog", {
			name: "Preview search settings",
		});
		await dialog.getByRole("combobox", { name: "Search destination" }).click();
		await page.getByRole("option", { name: "Local Preview" }).click();
		await expect(dialog.getByText("1 to 8 of 4100")).toBeVisible();
		await dialog.getByRole("button", { name: "Next rules" }).click();
		await expect(dialog.getByLabel("Text to ignore").first()).toHaveValue(
			ignoredText[8].literal,
		);
		await dialog.getByLabel("Project space time zone").fill("US/Eastern");
		await dialog.getByRole("button", { name: "Save settings" }).click();
		await expect(dialog).toBeHidden();
		const result = await pool.query(
			`SELECT revision::text,settings FROM preview_search_settings WHERE project_id=(SELECT project_id FROM apps WHERE id=$1) AND server='local'`,
			[appId],
		);
		expect(result.rows).toEqual([
			{ revision: "2", settings: { ...initial, timeZone: "US/Eastern" } },
		]);
	} finally {
		await pool.end();
	}
});
