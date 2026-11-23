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
			.getByRole("menuitem", {
				name: "Preview search and map settings",
				exact: true,
			})
			.click();
		const dialog = tab.getByRole("dialog", {
			name: "Preview search and map settings",
		});
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
		await expect(
			viewing.getByRole("combobox", { name: "Web Apps record map" }),
		).toBeDisabled();
		await expect(
			viewing.getByRole("combobox", { name: "Web Apps record map" }),
		).toHaveText("Not recorded");
		await first.getByRole("combobox", { name: "Web Apps record map" }).click();
		await page.getByRole("option", { name: "Available", exact: true }).click();
		await first.getByLabel("Project space time zone").fill("Europe/Paris");
		await first.getByRole("button", { name: "Save settings" }).click();
		await expect(first).toBeHidden();
		await expect(viewing.getByLabel("Project space time zone")).toHaveValue(
			"Europe/Paris",
		);
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"Europe/Paris",
		);
		await expect(
			viewing.getByRole("combobox", { name: "Web Apps record map" }),
		).toHaveText("Available");
		await expect(
			second.getByRole("combobox", { name: "Web Apps record map" }),
		).toHaveText("Available");
		await second.getByLabel("Project space time zone").fill("Asia/Kolkata");
		await page.getByRole("button", { name: /Running as/ }).click();
		await page
			.getByRole("menuitem", {
				name: "Preview search and map settings",
				exact: true,
			})
			.click();
		await first.getByRole("combobox", { name: "Web Apps record map" }).click();
		await page
			.getByRole("option", { name: "Unavailable", exact: true })
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
		await expect(
			second.getByRole("combobox", { name: "Web Apps record map" }),
		).toHaveText("Unavailable");
		await expect(
			viewing.getByRole("combobox", { name: "Web Apps record map" }),
		).toHaveText("Unavailable");
		await expect(second).toContainText("Supplied by your team");
		// A second conflict: keeping the edits carries this editor's time zone
		// over the teammate's record map change, and Save works again.
		await second.getByLabel("Project space time zone").fill("Asia/Kolkata");
		await page.getByRole("button", { name: /Running as/ }).click();
		await page
			.getByRole("menuitem", {
				name: "Preview search and map settings",
				exact: true,
			})
			.click();
		await first.getByRole("combobox", { name: "Web Apps record map" }).click();
		await page.getByRole("option", { name: "Available", exact: true }).click();
		await first.getByRole("button", { name: "Save settings" }).click();
		await expect(first).toBeHidden();
		await expect(second).toContainText("A teammate updated these settings");
		await second.getByRole("button", { name: "Keep my edits" }).click();
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"Asia/Kolkata",
		);
		await expect(
			second.getByRole("combobox", { name: "Web Apps record map" }),
		).toHaveText("Available");
		await second.getByRole("button", { name: "Save settings" }).click();
		await expect(second).toBeHidden();
		await expect(viewing.getByLabel("Project space time zone")).toHaveValue(
			"Asia/Kolkata",
		);
		await expect(
			viewing.getByRole("combobox", { name: "Web Apps record map" }),
		).toHaveText("Available");
	} finally {
		await viewer.close();
		await peer.close();
	}
});

test("changes a calendar and a single ordered rule in a saved profile larger than the action limit", {
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
			.getByRole("menuitem", {
				name: "Preview search and map settings",
				exact: true,
			})
			.click();
		const dialog = page.getByRole("dialog", {
			name: "Preview search and map settings",
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
		await page.getByRole("button", { name: /Running as/ }).click();
		await page
			.getByRole("menuitem", {
				name: "Preview search and map settings",
				exact: true,
			})
			.click();
		await expect(dialog.getByLabel("Project space time zone")).toHaveValue(
			"US/Eastern",
		);
		await dialog.getByRole("button", { name: "Next rules" }).click();
		await dialog.getByLabel("Text to ignore").first().fill("updated literal");
		await dialog.getByRole("button", { name: "Save settings" }).click();
		await expect(dialog).toBeHidden();
		const after = await pool.query(
			`SELECT revision::text,settings FROM preview_search_settings WHERE project_id=(SELECT project_id FROM apps WHERE id=$1) AND server='local'`,
			[appId],
		);
		const expected = ignoredText.map((r, i) =>
			i === 8 ? { ...r, literal: "updated literal" } : r,
		);
		expect(after.rows).toEqual([
			{
				revision: "3",
				settings: {
					...initial,
					timeZone: "US/Eastern",
					propertyMatchers: { fuzzyProperties: [], ignoredText: expected },
				},
			},
		]);
	} finally {
		await pool.end();
	}
});
