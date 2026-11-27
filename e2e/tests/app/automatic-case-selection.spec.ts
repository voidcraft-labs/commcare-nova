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
	const preview = page.locator("main[data-preview-scroll-container]");
	const menu = (name: string) =>
		preview.getByRole("button", { name: `${name} 2 forms`, exact: true });
	const openMenu = (name: string) => menu(name).click();
	await openMenu("No batch cases");
	await expect(
		preview.getByRole("heading", { name: "No cases yet" }),
	).toBeVisible();
	await page.goBack();
	await openMenu("Too many batch cases");
	await expect(
		preview.getByRole("heading", {
			name: "51 cases match. This list can continue with up to 50.",
		}),
	).toBeVisible();
	await expect(
		preview.getByRole("button", { name: "Close group", exact: true }),
	).toHaveCount(0);
	await page.goBack();
	await openMenu("All batch cases");
	await expect(
		preview.getByRole("heading", { name: "51 cases selected" }),
	).toBeVisible();
	await preview.getByRole("button", { name: "Back", exact: true }).click();
	await expect(menu("All batch cases")).toBeVisible();
	await openMenu("All batch cases");

	await preview.getByRole("button", { name: "Close group" }).click();
	await expect(preview.getByRole("textbox", { name: "Form name" })).toHaveValue(
		"Close group",
	);
	const submit = preview.getByRole("button", { name: "Submit", exact: true });
	await expect(submit).toBeEnabled();
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
		await submit.click();
		await expect.poll(saved).toEqual(caseIds.toSorted());
	} finally {
		await db.end();
	}
});

test("closes 101 records from manual pages and automatic selection in the signed running app", {
	tag: "@seed:bounded-flat-close",
}, async ({ page, scenario }) => {
	const { boundedFlatCloseApps } = seedFor(scenario, "bounded-flat-close");
	const db = new Client({ connectionString: process.env.NOVA_DB_LOCAL_URL });
	await db.connect();
	try {
		for (const { appId, caseIds, autoSelect } of boundedFlatCloseApps) {
			await openBuilder(page, `/build/${appId}`);
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			const preview = page.locator("main[data-preview-scroll-container]");
			await preview.getByRole("button", { name: /^Member records/ }).click();
			const close = preview.getByRole("button", {
				name: "Close these records",
			});
			if (!autoSelect) {
				await close.click();
				const chooseShown = preview.getByRole("button", {
					name: "Choose all cases shown",
				});
				const pages = preview.getByRole("navigation", {
					name: "Results pages",
				});
				await chooseShown.click();
				await pages.getByRole("button", { name: "Next", exact: true }).click();
				await chooseShown.click();
				await pages.getByRole("button", { name: "Next", exact: true }).click();
				await chooseShown.click();
				await preview
					.getByRole("button", { name: "Continue", exact: true })
					.click();
			}
			if (autoSelect) {
				await expect(
					preview.getByRole("heading", { name: "101 cases selected" }),
				).toBeVisible();
				await close.click();
			}
			const submit = preview.getByRole("button", {
				name: "Submit",
				exact: true,
			});
			await expect(submit).toBeEnabled();
			await submit.click();
			await expect
				.poll(async () => {
					const { rows } = await db.query<{ case_id: string }>(
						"SELECT case_id FROM cases WHERE app_id = $1 AND status = 'closed' ORDER BY case_id",
						[appId],
					);
					return rows.map(({ case_id }) => case_id);
				})
				.toEqual(caseIds.toSorted());
		}
	} finally {
		await db.end();
	}
});
