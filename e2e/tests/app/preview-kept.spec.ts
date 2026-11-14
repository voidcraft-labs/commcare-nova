import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { KEPT_BASELINE_SEED } from "../../lib/keptBaselineSeed";
import { openBuilder } from "../../lib/pageLoads";

/**
 * Preview plays what the app's project space keeps in CommCare HQ. Two apps
 * of one fixture are each published to a project space whose last read holds
 * fuzzy search in case lists and the asterisk on required questions: on for
 * the first, at a new app's `no` for its twin. The page load carries those
 * facts to Preview, so the list filter finds a near miss only where fuzzy
 * search is on, and Preview on Android marks a required question only where
 * the asterisk setting is on, where Web Apps marks it on both. The
 * Publishing card lists the two settings with the date CommCare HQ held them
 * and offers to read them again, and the twin's card says nothing differs
 * from a new app's and still offers it.
 */

const { intake } = KEPT_BASELINE_SEED;

async function openPreview(page: Page, route: string): Promise<void> {
	await openBuilder(page, route);
	const toggle = page.getByRole("button", { name: "Preview", exact: true });
	await expect(toggle).toBeVisible({ timeout: 20_000 });
	await toggle.click();
}

/** Types the near miss into the patients list's filter, which leaves the
 * match only where the project space's fuzzy search is on. */
async function filterNearMiss(
	page: Page,
	route: string,
	finds: boolean,
): Promise<void> {
	const main = page.locator("main");
	await openPreview(page, route);
	const rows = main
		.getByRole("list", { name: "Cases", exact: true })
		.getByRole("listitem");
	const match = rows.filter({ hasText: KEPT_BASELINE_SEED.match });
	const other = rows.filter({ hasText: KEPT_BASELINE_SEED.other });
	await expect(match).toBeVisible({ timeout: 20_000 });
	await expect(other).toBeVisible();
	await main
		.getByLabel(/^Filter (results|this page)$/)
		.fill(KEPT_BASELINE_SEED.nearMiss);
	await expect(other).toHaveCount(0);
	await expect(match).toHaveCount(finds ? 1 : 0);
}

/** Opens the intake form in Web Apps, then on Android, and checks whether
 * each marks the required question: its accessible name ends in the word a
 * screen reader reads for the asterisk exactly where the asterisk shows. */
async function expectRequiredMarks(
	page: Page,
	route: string,
	marked: { readonly webApps: boolean; readonly android: boolean },
): Promise<void> {
	const main = page.locator("main");
	const identity = page.getByRole("button", { name: /^Running as / });
	const question = main.getByRole("textbox", { name: intake.questionLabel });
	const expectMark = async (shown: boolean) => {
		if (shown) await expect(question).toHaveAccessibleName(/Required\./);
		else await expect(question).not.toHaveAccessibleName(/Required\./);
	};

	await openPreview(page, route);
	await expect(identity).toHaveAccessibleName(/ in Web Apps\. /, {
		timeout: 20_000,
	});
	await expect(question).toBeVisible({ timeout: 20_000 });
	await expectMark(marked.webApps);

	await identity.click();
	await page.getByRole("menuitemradio", { name: /^Android/ }).click();
	await expect(identity).toHaveAccessibleName(/ on Android\. /);
	const start = main.getByRole("button", { name: "Start", exact: true });
	await expect(start).toBeVisible({ timeout: 20_000 });
	await start.click();
	await main
		.getByRole("button", { name: new RegExp(`^${intake.moduleName}`) })
		.click();
	await main
		.getByRole("button", { name: intake.formName, exact: true })
		.click();
	await expect(question).toBeVisible({ timeout: 20_000 });
	await expectMark(marked.android);
}

test("Preview and the Publishing card follow what the project space keeps", {
	tag: "@seed:kept-baseline",
}, async ({ scenario, page }) => {
	const { keptBaseline } = seedFor(scenario, "kept-baseline");
	test.setTimeout(180_000);
	const main = page.locator("main");

	await test.step("a near miss in the list filter finds the case where fuzzy search is on", async () => {
		await filterNearMiss(page, keptBaseline.kept.routes.patients, true);
	});

	await test.step("the same near miss finds nothing where the project space keeps it off", async () => {
		await filterNearMiss(page, keptBaseline.twin.routes.patients, false);
	});

	await test.step("Android marks a required question where the asterisk setting is on, as Web Apps always does", async () => {
		await expectRequiredMarks(page, keptBaseline.kept.routes.intake, {
			webApps: true,
			android: true,
		});
	});

	await test.step("Android marks none where the project space keeps it off, and Web Apps still does", async () => {
		await expectRequiredMarks(page, keptBaseline.twin.routes.intake, {
			webApps: true,
			android: false,
		});
	});

	const refresh = main.getByRole("button", {
		name: "Refresh from CommCare HQ",
		exact: true,
	});

	await test.step("the Publishing card lists both settings with their date and offers to read them again", async () => {
		await openBuilder(page, keptBaseline.kept.routes.publishing);
		await expect(
			main.getByText(
				/^These stay as they are in CommCare HQ, as it held them on .+:$/,
			),
		).toBeVisible({ timeout: 20_000 });
		const kept = main.getByRole("listitem");
		await expect(
			kept.filter({ hasText: /^Fuzzy search in case lists$/ }),
		).toBeVisible();
		await expect(
			kept.filter({ hasText: /^Asterisk on required questions$/ }),
		).toBeVisible();
		await expect(refresh).toBeVisible();
	});

	await test.step("the twin's card says nothing differs from a new app's and still offers to read them again", async () => {
		await openBuilder(page, keptBaseline.twin.routes.publishing);
		await expect(
			main.getByText(
				/^Every setting CommCare HQ keeps for this app matches a new app's, as it held them on .+\.$/,
			),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			main.getByText("Fuzzy search in case lists", { exact: true }),
		).toHaveCount(0);
		await expect(refresh).toBeVisible();
	});
});
