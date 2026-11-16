import type { Locator, Page } from "@playwright/test";
import {
	appsThatReadIt,
	CONNECT_TO_REFRESH_TABLE,
	MANAGE_IN_NOVA,
	MANAGED_PLACES_LABEL,
	MANAGED_PLACES_NO_PERSONA,
	MANAGED_TABLE_BADGE,
	MANAGEMENT_NEEDS_ADMIN,
	managedInNovaBanner,
	managedPlacesLevelsNote,
	managedTableBanner,
	manageInNovaTitle,
	OPEN_IN_HQ,
	REFRESH_FROM_HQ,
} from "@/lib/publish/managedData";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import { MANAGED_DATA_SEED } from "../../lib/managedDataSeed";
import { openBuilder } from "../../lib/pageLoads";
import { createSmokeContext } from "../../lib/smokeNetwork";

/**
 * Project data CommCare HQ manages, as a member sees it. The seeded app was
 * brought in with a lookup table and places that are copies of a project
 * space's: the table page says where the table lives and offers no edit, the
 * owner (connected on that server) is offered Refresh, Open in CommCare HQ
 * and Manage in Nova, and an editor with no connection is invited to connect
 * instead of refreshing. Manage in Nova names the app that reads the table,
 * and once confirmed the grid is editable in this tab and in a second one
 * without a reload. Organization says where the places live, offers no
 * place control, says what Nova assumed of the levels, and Users invites a
 * persona.
 *
 * Refresh and the hand-back read CommCare HQ from the Next server, which no
 * page route here answers, so this journey offers them and never presses
 * them; what they do is held by the deployment services' own tests.
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

test("data CommCare HQ manages reads as a copy, and Manage in Nova hands the table to Nova in every open tab", {
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

		await test.step("Manage in Nova names the app that reads the table, and confirmed, the grid is editable in both tabs", async () => {
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
			await dialog
				.getByRole("button", { name: MANAGE_IN_NOVA, exact: true })
				.click();
			await expect(dialog).toHaveCount(0);
			await expect(
				main.getByRole("button", { name: "Add row", exact: true }),
			).toBeVisible({ timeout: 20_000 });
			await expect(
				page.getByText(managedInNovaBanner(seed.domain), { exact: true }),
			).toBeVisible();
			// The stamped definition reaches the other tab as a manifest frame.
			await expect(
				second
					.locator("main")
					.getByRole("button", { name: "Add row", exact: true }),
			).toBeVisible({ timeout: 20_000 });
			await expect(
				second.getByText(managedInNovaBanner(seed.domain), { exact: true }),
			).toBeVisible();
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
