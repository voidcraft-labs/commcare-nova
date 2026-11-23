import type {
	Browser,
	BrowserContextOptions,
	Locator,
	Page,
} from "@playwright/test";
import {
	appsThatReadIt,
	CONNECT_TO_REFRESH_TABLE,
	KEEP_IN_HQ,
	MANAGE_IN_NOVA,
	MANAGED_PLACES_LABEL,
	MANAGED_PLACES_NO_PERSONA,
	MANAGED_TABLE_BADGE,
	MANAGEMENT_NEEDS_ADMIN,
	MANAGEMENT_REVIEW_MOVED,
	managedPlacesLevelsNote,
	managedTableBanner,
	manageInNovaTitle,
	OPEN_IN_HQ,
	REFRESH_FROM_HQ,
	SEPARATE_TABLE,
	SEPARATE_TABLE_CONFIRM,
	SEPARATE_TABLE_INDEXES,
	separateTableTitle,
} from "@/lib/publish/managedData";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import { MANAGED_DATA_SEED } from "../../lib/managedDataSeed";
import { openBuilder, openPage } from "../../lib/pageLoads";
import { createSmokeContext } from "../../lib/smokeNetwork";

/**
 * Project data CommCare HQ manages, as a member sees it. The seeded app was
 * brought in with a lookup table and places that are copies of a project
 * space's: the table page says where the table lives and offers no edit, the
 * owner (connected on that server) is offered Refresh, Open in CommCare HQ
 * and Manage in Nova, and an editor with no connection is invited to connect
 * instead of refreshing. Manage in Nova names the app that reads the table;
 * where a teammate makes a second app read it while the dialog is open, the
 * confirmation changes nothing, says why and names both apps, and in a
 * second tab too the table offers no edit. Organization says where the
 * places live, offers no place control, says what Nova assumed of the
 * levels, and Users invites a persona.
 *
 * Refresh, the hand-back and a confirmed Manage in Nova each read CommCare
 * HQ from the Next server, which no page route here answers, so this journey
 * offers them and never lets one reach CommCare HQ; what they do is held by
 * the deployment services' own tests.
 */

const seed = MANAGED_DATA_SEED;

/** The banner above the table, by its label. */
function tableBanner(page: Page, label: string) {
	return page.getByRole("complementary", { name: label, exact: true });
}

/** The banner's Open in CommCare HQ: a link drawn as a Button, which names
 *  itself a button as every link-styled Button in the app does. */
function openInHq(banner: Locator) {
	return banner.getByRole("button", { name: OPEN_IN_HQ, exact: true });
}

/** The edits a table offers an author, none of which a managed table offers. */
async function expectNoTableEdits(page: Page): Promise<void> {
	const main = page.locator("main");
	for (const name of [
		"Add row",
		"Add column",
		"Replace rows from CSV",
		"Rename",
		"Edit export tag",
	]) {
		await expect(main.getByRole("button", { name, exact: true })).toHaveCount(
			0,
		);
	}
}

/**
 * In a teammate's own session, the second app's choice question takes its
 * choices from the managed table, and the edit is saved.
 */
async function makeReaderAppReadTable(
	browser: Browser,
	baseURL: string | undefined,
	storageState: BrowserContextOptions["storageState"],
	managedData: {
		readonly tableId: string;
		readonly readerAppId: string;
		readonly routes: { readonly readerQuestion: string };
	},
): Promise<void> {
	const context = await createSmokeContext(browser, { baseURL, storageState });
	try {
		const teammate = await context.newPage();
		const guard = await attachErrorGuard(teammate, baseURL);
		try {
			await openBuilder(teammate, managedData.routes.readerQuestion);
			const source = teammate.locator('[data-field-id="options-source"]');
			await source
				.getByRole("combobox", {
					name: "Where the choices come from",
					exact: true,
				})
				.click();
			await teammate
				.getByRole("option", { name: seed.table.name, exact: true })
				.click();
			await source
				.getByRole("combobox", { name: "Value that gets saved", exact: true })
				.click();
			await teammate.getByRole("option", { name: "code", exact: true }).click();
			await source
				.getByRole("combobox", { name: "Value people see", exact: true })
				.click();
			await teammate.getByRole("option", { name: "name", exact: true }).click();
			const saved = teammate.waitForResponse((response) => {
				const request = response.request();
				return (
					new URL(response.url()).pathname ===
						`/api/apps/${managedData.readerAppId}` &&
					request.method() === "PUT" &&
					(request.postData() ?? "").includes(managedData.tableId)
				);
			});
			const [response] = await Promise.all([
				saved,
				source
					.getByRole("button", { name: "Use this table", exact: true })
					.click(),
			]);
			expect(response.ok()).toBe(true);
		} finally {
			await closePageWithUnload(teammate);
			await guard.assertNoErrors();
		}
	} finally {
		await context.close();
	}
}

test("data CommCare HQ manages reads as a copy, and Manage in Nova changes nothing over a review a teammate moved", {
	tag: "@seed:managed-data",
}, async ({ scenario, page, browser, baseURL }) => {
	const fixture = seedFor(scenario, "managed-data");
	const { managedData } = fixture;
	const { routes } = managedData;
	test.setTimeout(150_000);
	const main = page.locator("main");

	await test.step("the table list marks the table managed in CommCare HQ", async () => {
		await openBuilder(page, routes.tables);
		const row = main.getByRole("button", { name: new RegExp(seed.table.name) });
		await expect(row).toBeVisible({ timeout: 20_000 });
		await expect(
			row.getByText(MANAGED_TABLE_BADGE, { exact: true }),
		).toBeVisible();
	});

	await test.step("the table page says where the table lives, offers its three actions, and no edit", async () => {
		await openBuilder(page, routes.table);
		const banner = tableBanner(page, MANAGED_TABLE_BADGE);
		await expect(banner).toBeVisible({ timeout: 20_000 });
		await expect(
			banner.getByText(managedTableBanner(seed.domain)),
		).toBeVisible();
		await expect(
			banner.getByRole("button", { name: REFRESH_FROM_HQ, exact: true }),
		).toBeEnabled({ timeout: 20_000 });
		await expect(openInHq(banner)).toHaveAttribute(
			"href",
			`https://india.commcarehq.org/a/${seed.domain}/fixtures/`,
		);
		await expect(
			banner.getByRole("button", { name: MANAGE_IN_NOVA, exact: true }),
		).toBeEnabled();
		await expectNoTableEdits(page);
		// Removing Nova's copy stays the owner's, as for any table.
		await expect(
			main.getByRole("button", { name: "Delete table", exact: true }),
		).toBeVisible();
	});

	await test.step("an editor with no CommCare HQ connection is invited to connect, and told who can manage it in Nova", async () => {
		const editorContext = await createSmokeContext(browser, {
			baseURL,
			storageState: fixture.viewerStorageState,
		});
		try {
			const editorPage = await editorContext.newPage();
			const guard = await attachErrorGuard(editorPage, baseURL);
			try {
				await openBuilder(editorPage, routes.table);
				const banner = tableBanner(editorPage, MANAGED_TABLE_BADGE);
				await expect(
					banner.getByRole("link", {
						name: CONNECT_TO_REFRESH_TABLE,
						exact: true,
					}),
				).toBeVisible({ timeout: 20_000 });
				await expect(
					banner.getByRole("button", { name: REFRESH_FROM_HQ, exact: true }),
				).toHaveCount(0);
				await expect(
					banner.getByRole("button", { name: MANAGE_IN_NOVA, exact: true }),
				).toBeDisabled();
				await expect(
					banner.getByText(MANAGEMENT_NEEDS_ADMIN, { exact: true }),
				).toBeVisible();
				await expectNoTableEdits(editorPage);
				await expect(
					editorPage
						.locator("main")
						.getByRole("button", { name: "Delete table", exact: true }),
				).toHaveCount(0);
			} finally {
				await closePageWithUnload(editorPage);
				await guard.assertNoErrors();
			}
		} finally {
			await editorContext.close();
		}
	});

	const second = await page.context().newPage();
	const secondGuard = await attachErrorGuard(second, baseURL);
	try {
		await test.step("a second tab of the same table offers no edit either", async () => {
			await openBuilder(second, routes.table);
			await expect(tableBanner(second, MANAGED_TABLE_BADGE)).toBeVisible({
				timeout: 20_000,
			});
			await expectNoTableEdits(second);
		});

		await test.step("Manage in Nova names the app that reads the table, and over a moved review changes nothing in either tab", async () => {
			await tableBanner(page, MANAGED_TABLE_BADGE)
				.getByRole("button", { name: MANAGE_IN_NOVA, exact: true })
				.click();
			const dialog = page.getByRole("alertdialog", {
				name: manageInNovaTitle(seed.table.name),
			});
			await expect(dialog).toBeVisible();
			await expect(
				dialog.getByText(
					appsThatReadIt([{ appName: seed.appName, deleted: false }]) ?? "",
					{ exact: true },
				),
			).toBeVisible();

			/* While the owner decides, a teammate makes another app of the
			 * Project read the table. */
			await makeReaderAppReadTable(
				browser,
				baseURL,
				fixture.viewerStorageState,
				managedData,
			);

			/* The answer was given over the review the dialog showed, so
			 * nothing changes: the dialog says why and names both apps now. */
			const confirm = dialog.getByRole("button", {
				name: MANAGE_IN_NOVA,
				exact: true,
			});
			await confirm.click();
			await expect(dialog.getByRole("alert")).toHaveText(
				MANAGEMENT_REVIEW_MOVED,
			);
			await expect(
				dialog.getByText(
					appsThatReadIt([
						{ appName: seed.appName, deleted: false },
						{ appName: seed.readerApp.name, deleted: false },
					]) ?? "",
					{ exact: true },
				),
			).toBeVisible();
			await expectNoTableEdits(page);
			await expect(confirm).toBeEnabled();
			/* Confirmed again, the hand-over reads the table from CommCare HQ
			 * on the Next server first, which this journey never reaches (see
			 * above); the owner keeps it there instead, and neither tab offers
			 * an edit. */
			await dialog
				.getByRole("button", { name: KEEP_IN_HQ, exact: true })
				.click();
			await expect(dialog).toHaveCount(0);
			await expectNoTableEdits(page);
			await expectNoTableEdits(second);
		});
	} finally {
		await closePageWithUnload(second);
		await secondGuard.assertNoErrors();
	}

	await test.step("Organization says where the places live, offers no place control, and says what Nova assumed of the levels", async () => {
		await openBuilder(page, routes.organization);
		const banner = page.getByRole("complementary", {
			name: MANAGED_PLACES_LABEL,
			exact: true,
		});
		await expect(banner).toBeVisible({ timeout: 20_000 });
		await expect(
			banner.getByRole("button", { name: REFRESH_FROM_HQ, exact: true }),
		).toBeEnabled({ timeout: 20_000 });
		await expect(openInHq(banner)).toHaveAttribute(
			"href",
			`https://india.commcarehq.org/a/${seed.domain}/settings/locations/list/`,
		);
		await expect(
			main.getByText(managedPlacesLevelsNote(seed.domain), { exact: true }),
		).toBeVisible();
		const places = main.getByRole("region", { name: "Places", exact: true });
		await expect(
			places.getByRole("button", { name: "Add place", exact: true }),
		).toHaveCount(0);
		await places
			.getByRole("button", { name: new RegExp(seed.places.district.name) })
			.click();
		await expect(
			places.getByRole("textbox", { name: "Name", exact: true }),
		).toBeDisabled();
		await expect(
			places.getByRole("button", { name: "Archive", exact: true }),
		).toHaveCount(0);
	});

	await test.step("Users invites a persona to see the places in Preview", async () => {
		await openBuilder(page, routes.users);
		await expect(
			main.getByText(MANAGED_PLACES_NO_PERSONA, { exact: true }),
		).toBeVisible({ timeout: 20_000 });
	});
});

test("Create a separate table points the chosen app at a new Nova table and leaves the copy CommCare HQ manages as it was", {
	tag: "@seed:managed-data",
}, async ({ scenario, page }) => {
	const { managedData } = seedFor(scenario, "managed-data");
	const { routes } = managedData;
	test.setTimeout(120_000);
	const main = page.locator("main");
	await openBuilder(page, routes.table);
	await expect(tableBanner(page, MANAGED_TABLE_BADGE)).toBeVisible({
		timeout: 20_000,
	});
	await main.getByRole("button", { name: SEPARATE_TABLE, exact: true }).click();
	const dialog = page.getByRole("alertdialog", {
		name: separateTableTitle(seed.table.name),
	});
	await expect(dialog).toBeVisible({ timeout: 20_000 });
	/* CommCare HQ never said which of the copy's columns are indexed, so the
	 * confirmation says the new table indexes none. */
	await expect(
		dialog.getByText(SEPARATE_TABLE_INDEXES, { exact: true }),
	).toBeVisible();
	const confirm = dialog.getByRole("button", {
		name: SEPARATE_TABLE_CONFIRM,
		exact: true,
	});
	await expect(confirm).toBeDisabled();
	const name = dialog.getByRole("textbox", {
		name: "New table's name",
		exact: true,
	});
	await expect(name).toHaveValue(`${seed.table.name} 2`);
	await name.fill(`${seed.table.name} for visits`);
	await dialog
		.getByRole("checkbox", { name: seed.appName, exact: true })
		.click();
	await expect(confirm).toBeEnabled();
	await confirm.click();
	await expect(dialog).toHaveCount(0, { timeout: 20_000 });

	await openBuilder(page, routes.tables);
	await expect(
		main.getByRole("button", {
			name: new RegExp(`${seed.table.name} for visits`),
		}),
	).toBeVisible({ timeout: 20_000 });
	/* The copy is still CommCare HQ's, and offers no edit. */
	await openBuilder(page, routes.table);
	await expect(tableBanner(page, MANAGED_TABLE_BADGE)).toBeVisible({
		timeout: 20_000,
	});
	await expectNoTableEdits(page);
});

test("a disconnected source editor cannot read staged inventory or a mobile worker’s data", {
	tag: "@seed:source-inventory",
}, async ({ page, scenario }) => {
	const { sourceInventory } = seedFor(scenario, "source-inventory");
	await openBuilder(page, sourceInventory.route);
	const openSource = page.getByRole("button", {
		name: "View source inventory",
	});
	await expect(openSource).toBeVisible();
	const settings = await page.context().newPage();
	try {
		await openPage(settings, "/settings");
		const disconnect = settings.getByRole("button", {
			name: "Disconnect",
			exact: true,
		});
		await disconnect.click();
		await expect(disconnect).toHaveCount(0);
	} finally {
		await settings.close();
	}
	await openSource.click();
	const dialog = page.getByRole("dialog", { name: "Source inventory" });
	await expect(dialog.getByRole("alert")).toContainText(/connection/i);
	await expect(
		dialog.getByRole("button", { name: "Read first row" }),
	).toHaveCount(0);
	await expect(dialog.getByText(/rows recorded|refresh has read/)).toHaveCount(
		0,
	);
	// The footer's Close, beside the dialog's corner one of the same name.
	await dialog
		.locator('[data-slot="dialog-footer"]')
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await page.getByRole("button", { name: "Check source access" }).click();
	const access = page.getByRole("dialog", { name: "Check source access" });
	const worker = access.getByLabel("Mobile worker username");
	await expect(worker).toHaveValue("");
	await expect(
		access.getByText(/leave this blank to check your connected account/),
	).toBeVisible();
	await expect(
		access.getByLabel("Selected-table workbook (.xlsx, up to 768 KiB)"),
	).toBeVisible();
	await expect(
		access.getByRole("button", { name: "Check and record workbook" }),
	).toBeDisabled();
	await worker.fill("clinic-worker");
	await access.getByRole("button", { name: "Check worker data" }).click();
	await expect(access.getByRole("alert")).toContainText(
		/connection|connect|available/i,
	);
	await expect(access.getByText("Hill clinic", { exact: true })).toHaveCount(0);
	await expect(access.getByText(/could read [0-9]+ rows?/)).toHaveCount(0);
});
