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

test("submits a bounded 101-record selection from manual pages and automatic selection", {
	tag: "@seed:bounded-flat-close",
}, async ({ page, scenario }) => {
	const { boundedFlatCloseApps } = seedFor(scenario, "bounded-flat-close");
	const db = new Client({ connectionString: process.env.NOVA_DB_LOCAL_URL });
	await db.connect();
	try {
		for (const {
			appId,
			caseIds,
			autoSelect,
			formName,
			closes,
		} of boundedFlatCloseApps) {
			await openBuilder(page, `/build/${appId}`);
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			const preview = page.locator("main[data-preview-scroll-container]");
			await preview.getByRole("button", { name: /^Member records/ }).click();
			const form = preview.getByRole("button", { name: formName, exact: true });
			if (!autoSelect) {
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
			await expect(
				preview.getByRole("heading", { name: "101 cases selected" }),
			).toBeVisible();
			await form.click();
			if (!closes)
				await preview
					.getByRole("textbox", { name: "Outcome", exact: true })
					.fill("Reviewed");

			const submit = preview.getByRole("button", {
				name: "Submit",
				exact: true,
			});
			await expect(submit).toBeEnabled();
			const queryState = async () => {
				const { rows } = await db.query(
					"SELECT case_id, status, modified_on FROM cases WHERE app_id = $1 ORDER BY case_id",
					[appId],
				);
				return rows;
			};
			const before = closes ? undefined : await queryState();
			await submit.click();
			if (!closes) {
				await expect(
					preview.getByRole("button", { name: /^Member records/ }),
				).toBeVisible();
				expect(await queryState()).toEqual(before);
				continue;
			}
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
